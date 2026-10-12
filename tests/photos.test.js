// Student photos: private storage under the school's path, short-lived links, real file-type checks, safe migration.
const mockCloud = { assets: new Map(), uploads: [], destroyed: [], urls: [] };
jest.mock('../src/config/cloudinary', () => ({
  uploader: {
    upload_stream: (options, cb) => {
      const { PassThrough } = require('stream');
      const sink = new PassThrough();
      const chunks = [];
      sink.on('data', (c) => chunks.push(c));
      sink.on('end', () => { mockCloud.uploads.push(options); mockCloud.assets.set(options.public_id, Buffer.concat(chunks)); cb(null, { public_id: options.public_id }); });
      sink.resume();
      return sink;
    },
    upload: async (source, options) => {
      if (String(source).includes('missing')) throw new Error('source not found');
      mockCloud.uploads.push({ ...options, source });
      mockCloud.assets.set(options.public_id, Buffer.from('copied'));
      return { public_id: options.public_id };
    },
    destroy: async (key, options) => { mockCloud.destroyed.push({ key, ...options }); mockCloud.assets.delete(key); return { result: 'ok' }; },
  },
  api: { resource: async (key) => { if (!mockCloud.assets.has(key)) throw new Error('not found'); return { public_id: key }; } },
  url: (key, options) => { mockCloud.urls.push({ key, ...options }); return `https://cdn.test/${options.type}/${key}`; },
}));

const { api, connect, disconnect, clear, auth, seedSchool, makeUser } = require('./helpers');
const Student = require('../src/models/Student');
const photos = require('../src/services/photos');
const { migratePhotos, legacyPublicId } = require('../src/scripts/migratePhotos');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 2)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(40, 3)]);

let A;
let B;
const realFetch = global.fetch;

beforeAll(async () => {
  await connect();
  // The private download goes through fetch: serve whatever the fake mockCloud holds for the requested key.
  global.fetch = jest.fn(async (url) => {
    const key = String(url).replace(/^https:\/\/cdn\.test\/authenticated\//, '');
    const body = mockCloud.assets.get(key);
    if (!body) return { ok: false, headers: { get: () => null } };
    return { ok: true, headers: { get: () => 'image/png' }, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) };
  });
});
afterAll(async () => { global.fetch = realFetch; await disconnect(); });
beforeEach(async () => {
  await clear();
  mockCloud.assets.clear(); mockCloud.uploads.length = 0; mockCloud.destroyed.length = 0; mockCloud.urls.length = 0;
  A = await seedSchool('Alpha School');
  B = await seedSchool('Beta School');
});

const create = (ctx, file, extra = {}) => {
  const fields = { name: 'Photo Kid', phone: '9123456789', class: '10', section: 'A', ...extra };
  let req = api().post('/api/students').set(auth(ctx.admin));
  for (const [k, v] of Object.entries(fields)) req = req.field(k, v);
  return file ? req.attach('photo', file.buffer, { filename: file.name, contentType: file.type }) : req;
};
const png = { buffer: PNG, name: 'kid.png', type: 'image/png' };
const linkPath = (url) => url.replace(/^https?:\/\/[^/]+/, '');

describe('upload and storage', () => {
  test('a new photo is stored as a private asset under the school\'s own path', async () => {
    const res = await create(A, png);
    expect(res.status).toBe(201);
    const stored = await Student.findById(res.body.data._id);
    expect(stored.photoKey).toMatch(new RegExp(`^eduamigo/${A.school._id}/students/[a-f0-9]{32}$`));
    expect(stored.photo).toBeUndefined();
    const opts = mockCloud.uploads[0];
    expect(opts).toMatchObject({ type: 'authenticated', resource_type: 'image', public_id: stored.photoKey, overwrite: false });
    expect(opts.allowed_formats).toEqual(['jpg', 'png', 'webp']);
    expect(mockCloud.assets.get(stored.photoKey).equals(PNG)).toBe(true);
  });

  test('the API shows a private link and never the storage key or a mockCloud address', async () => {
    const created = await create(A, png);
    const res = await api().get(`/api/students/${created.body.data._id}`).set(auth(A.admin));
    expect(res.status).toBe(200);
    expect(res.body.data.photo).toMatch(/\/api\/photos\/[\w-]+\.[\w-]+$/);
    expect(JSON.stringify(res.body)).not.toMatch(/photoKey|cloudinary|cdn\.test|eduamigo\//);
  });

  test('a photo address typed into the form is ignored: only an uploaded file becomes a photo', async () => {
    const res = await create(A, null, { photo: 'https://tracker.example/pixel.png', photoKey: 'eduamigo/x/students/y' });
    expect(res.status).toBe(201);
    const stored = await Student.findById(res.body.data._id);
    expect(stored.photo).toBeUndefined();
    expect(stored.photoKey).toBeUndefined();
    const upd = await api().put(`/api/students/${stored._id}`).set(auth(A.admin)).send({ photo: 'https://tracker.example/p.png', name: 'Renamed' });
    expect(upd.status).toBe(200);
    expect((await Student.findById(stored._id)).photo).toBeUndefined();
  });

  test('a failed admission leaves no uploaded file behind', async () => {
    await create(A, null, { admissionNo: 'ADM-1' });
    const before = mockCloud.uploads.length;
    const res = await create(A, png, { admissionNo: 'ADM-1', phone: '9123456780' });
    expect(res.status).toBe(409);
    expect(mockCloud.uploads.length).toBe(before + 1);
    expect(mockCloud.destroyed).toHaveLength(1);
    expect(mockCloud.destroyed[0]).toMatchObject({ type: 'authenticated', key: mockCloud.uploads[before].public_id });
    expect(mockCloud.assets.size).toBe(0);
  });

  test('replacing a photo removes the old private file, and a rejected edit uploads nothing', async () => {
    const created = await create(A, png);
    const id = created.body.data._id;
    const oldKey = (await Student.findById(id)).photoKey;
    const put = await api().put(`/api/students/${id}`).set(auth(A.admin)).attach('photo', JPEG, { filename: 'n.jpg', contentType: 'image/jpeg' });
    expect(put.status).toBe(200);
    const fresh = await Student.findById(id);
    expect(fresh.photoKey).not.toBe(oldKey);
    expect(mockCloud.destroyed.map((d) => d.key)).toContain(oldKey);
    expect(mockCloud.assets.has(oldKey)).toBe(false);
    expect(mockCloud.assets.has(fresh.photoKey)).toBe(true);

    const uploadsBefore = mockCloud.uploads.length;
    const bad = await api().put(`/api/students/${id}`).set(auth(A.admin)).field('admissionNo', '').attach('photo', PNG, { filename: 'n.png', contentType: 'image/png' });
    expect(bad.status).toBe(400);
    expect(mockCloud.uploads.length).toBe(uploadsBefore);
  });
});

describe('what counts as an image', () => {
  const attempt = (buffer, type, name = 'f.png') => create(A, { buffer, name, type });

  test('JPEG, PNG and WebP are accepted by their bytes', async () => {
    expect((await attempt(PNG, 'image/png')).status).toBe(201);
    const jpeg = await create(A, { buffer: JPEG, name: 'f.jpg', type: 'image/jpeg' }, { phone: '9000000055' });
    expect(jpeg.status).toBe(201);
    expect((await create(A, { buffer: WEBP, name: 'f.webp', type: 'image/webp' }, { phone: '9000000077' })).status).toBe(201);
  });

  test('text or a script sent as image/png is refused', async () => {
    const res = await attempt(Buffer.from('<?php echo 1; ?> just text, not an image'), 'image/png');
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/not a valid JPEG, PNG or WebP/);
    expect(mockCloud.uploads).toHaveLength(0);
  });

  test('an SVG is refused whatever it claims to be', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>');
    expect((await attempt(svg, 'image/svg+xml', 'a.svg')).status).toBe(400);
    expect((await attempt(svg, 'image/png', 'a.png')).status).toBe(400);
  });

  test('a real image sent with a wrong claimed type is refused too', async () => {
    expect((await attempt(PNG, 'application/pdf', 'a.pdf')).status).toBe(400);
  });

  test('an empty or tiny file is refused', async () => {
    expect((await attempt(Buffer.from([0xff, 0xd8]), 'image/jpeg', 'a.jpg')).status).toBe(400);
  });
});

describe('private links', () => {
  let studentId;
  let link;
  beforeEach(async () => {
    const created = await create(A, png);
    studentId = created.body.data._id;
    link = linkPath((await api().get(`/api/students/${studentId}`).set(auth(A.admin))).body.data.photo);
  });

  test('the link shows the picture without a login, with private caching and no sniffing', async () => {
    const res = await api().get(link);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/image\/png/);
    expect(res.headers['cache-control']).toMatch(/private/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toMatch(/sandbox/);
    expect(Buffer.from(res.body).equals(PNG)).toBe(true);
    expect(mockCloud.urls.at(-1)).toMatchObject({ type: 'authenticated', sign_url: true, secure: true });
  });

  test('the same student gets the same link within a short window, so the browser can cache it', async () => {
    const again = linkPath((await api().get(`/api/students/${studentId}`).set(auth(A.admin))).body.data.photo);
    expect(again).toBe(link);
  });

  test('a changed, cut or made-up link gets a plain 404', async () => {
    const token = link.split('/').pop();
    const [payload, sig] = token.split('.');
    const flipped = `${payload}.${sig.slice(0, -2)}${sig.slice(-2) === 'AA' ? 'BB' : 'AA'}`;
    for (const t of [flipped, payload, `${payload}.`, 'garbage', `${payload}.${sig}.x`, 'a'.repeat(500)]) {
      const res = await api().get(`/api/photos/${t}`);
      expect(res.status).toBe(404);
      expect(res.text).toBe('');
    }
  });

  test('an expired link stops working', async () => {
    const key = (await Student.findById(studentId)).photoKey;
    const old = photos.createToken(key, Date.now() - 5 * 60 * 60 * 1000);
    expect((await api().get(`/api/photos/${old}`)).status).toBe(404);
    expect((await api().get(`/api/photos/${photos.createToken(key)}`)).status).toBe(200);
  });

  test('a link cannot be pointed at another path, even if it were signed', () => {
    for (const bad of ['eduamigo/../../etc/passwd', 'student_photos/abc', `eduamigo/${A.school._id}/students/short`, 'eduamigo/xyz/students/' + 'a'.repeat(32)]) {
      expect(photos.readToken(photos.createToken(bad))).toBeNull();
    }
  });

  test('a link made with another secret is refused', () => {
    const key = `eduamigo/${A.school._id}/students/${'b'.repeat(32)}`;
    const token = photos.createToken(key);
    const saved = process.env.JWT_SECRET;
    process.env.JWT_SECRET = 'a-completely-different-secret-of-sufficient-length';
    try { expect(photos.readToken(token)).toBeNull(); } finally { process.env.JWT_SECRET = saved; }
  });

  test('whoever may not see the student gets no link in the first place', async () => {
    expect((await api().get(`/api/students/${studentId}`).set(auth(B.admin))).status).toBe(404);
    expect((await api().get(`/api/students/${studentId}`).set(auth(A.parentUser))).status).toBeGreaterThanOrEqual(403);
  });

  test('the student and the linked parent are shown the photo; the file is gone from the mockCloud once deleted', async () => {
    const kidUser = await makeUser(A.school, 'student');
    await Student.updateOne({ _id: studentId }, { userId: kidUser._id, parentUserId: A.parentUser._id });
    const mine = await api().get('/api/students/my-profile').set(auth(kidUser));
    expect(mine.body.data.photo).toMatch(/\/api\/photos\//);
    const parent = await api().get('/api/parents/my-child').set(auth(A.parentUser));
    const child = parent.body.data.children.find((c) => String(c._id) === String(studentId));
    expect(child?.photo).toMatch(/\/api\/photos\//);
    mockCloud.assets.clear();
    expect((await api().get(link)).status).toBe(404);
  });
});

describe('existing photos keep working until they are migrated', () => {
  const legacy = 'https://res.cloudinary.com/demo/image/upload/v1700000000/student_photos/abc123.jpg';

  test('an old public address is still shown as it is', async () => {
    await Student.updateOne({ _id: A.student._id }, { photo: legacy });
    const res = await api().get(`/api/students/${A.student._id}`).set(auth(A.admin));
    expect(res.body.data.photo).toBe(legacy);
  });

  test('address parsing only accepts our own student_photos files', () => {
    expect(legacyPublicId(legacy)).toBe('student_photos/abc123');
    expect(legacyPublicId('https://res.cloudinary.com/demo/image/upload/student_photos/x_y-1.png')).toBe('student_photos/x_y-1');
    for (const other of ['https://evil.example/student_photos/abc.jpg', 'https://res.cloudinary.com/demo/image/upload/other/abc.jpg', '', null]) {
      expect(legacyPublicId(other)).toBeNull();
    }
  });
});

describe('migrating old photos', () => {
  const legacy = (name) => `https://res.cloudinary.com/demo/image/upload/v1/student_photos/${name}.jpg`;
  let s1; let s2; let s3; let s4;
  beforeEach(async () => {
    [s1, s2] = [A.student, A.otherStudent];
    s3 = B.student;
    s4 = B.otherStudent;
    await Student.updateOne({ _id: s1._id }, { photo: legacy('one') });
    await Student.updateOne({ _id: s2._id }, { photo: legacy('two') });
    await Student.updateOne({ _id: s3._id }, { photo: legacy('three') });
    await Student.updateOne({ _id: s4._id }, { photo: 'https://other.example/p.png' });
  });

  test('a dry run reports and changes nothing', async () => {
    const report = await migratePhotos({ quiet: true });
    expect(report).toMatchObject({ students_with_photo: 4, to_copy: 3, foreign_address: 1, copied: 0 });
    expect(mockCloud.uploads).toHaveLength(0);
    expect((await Student.findById(s1._id)).photoKey).toBeUndefined();
  });

  test('stage A copies privately into each student\'s own school, and keeps the old address and file', async () => {
    const report = await migratePhotos({ apply: true, quiet: true });
    expect(report).toMatchObject({ copied: 3, copy_failed: 0, foreign_address: 1 });
    for (const [student, school] of [[s1, A], [s2, A], [s3, B]]) {
      const doc = await Student.findById(student._id);
      expect(doc.photoKey).toMatch(new RegExp(`^eduamigo/${school.school._id}/students/[a-f0-9]{32}$`));
      expect(doc.photo).toMatch(/student_photos/); // still there: nothing public was removed
    }
    expect(mockCloud.destroyed).toHaveLength(0);
    expect((await Student.findById(s4._id)).photoKey).toBeUndefined();
    const shown = (await api().get(`/api/students/${s1._id}`).set(auth(A.admin))).body.data.photo;
    expect(shown).toMatch(/\/api\/photos\//); // the app already uses the private copy
  });

  test('running stage A again changes nothing more', async () => {
    await migratePhotos({ apply: true, quiet: true });
    const keys = (await Student.find({ photoKey: { $exists: true } })).map((s) => s.photoKey).sort();
    const again = await migratePhotos({ apply: true, quiet: true });
    expect(again).toMatchObject({ copied: 0, already_private: 3, to_copy: 0 });
    expect((await Student.find({ photoKey: { $exists: true } })).map((s) => s.photoKey).sort()).toEqual(keys);
  });

  test('one failing photo does not stop the others and leaves no half copy', async () => {
    await Student.updateOne({ _id: s2._id }, { photo: legacy('missing-file') });
    const report = await migratePhotos({ apply: true, quiet: true });
    expect(report).toMatchObject({ copied: 2, copy_failed: 1 });
    expect((await Student.findById(s2._id)).photoKey).toBeUndefined();
    expect((await Student.findById(s2._id)).photo).toMatch(/missing-file/);
    expect(mockCloud.destroyed.some((d) => d.type === 'authenticated')).toBe(true);
  });

  test('undoing stage A is one update, and the old public photos work again', async () => {
    await migratePhotos({ apply: true, quiet: true });
    await Student.collection.updateMany({ photoKey: { $exists: true } }, { $unset: { photoKey: 1 } });
    const res = await api().get(`/api/students/${s1._id}`).set(auth(A.admin));
    expect(res.body.data.photo).toBe(legacy('one'));
  });

  test('stage B needs --apply to do anything, and only deletes after checking the private copy exists', async () => {
    await migratePhotos({ apply: true, quiet: true });
    const dry = await migratePhotos({ finalize: true, quiet: true });
    expect(dry).toMatchObject({ to_finalize: 3, finalized: 0 });
    expect(mockCloud.destroyed).toHaveLength(0);

    mockCloud.assets.delete((await Student.findById(s2._id)).photoKey); // the private copy of one student is lost
    const done = await migratePhotos({ finalize: true, apply: true, quiet: true });
    expect(done).toMatchObject({ finalized: 2, finalize_failed: 1 });
    expect((await Student.findById(s1._id)).photo).toBeUndefined();
    expect((await Student.findById(s2._id)).photo).toMatch(/student_photos/); // kept, because the copy could not be confirmed
    expect(mockCloud.destroyed.filter((d) => d.type === 'upload').map((d) => d.key).sort()).toEqual(['student_photos/one', 'student_photos/three']);
  });
});

describe('logs', () => {
  test('the private link token is never written to the request log', async () => {
    process.env.LOG_IN_TESTS = 'true';
    const lines = [];
    const spy = jest.spyOn(process.stdout, 'write').mockImplementation((c) => { lines.push(String(c)); return true; });
    let token;
    try {
      const created = await create(A, png);
      const shown = (await api().get(`/api/students/${created.body.data._id}`).set(auth(A.admin))).body.data.photo;
      token = linkPath(shown).split('/').pop();
      await api().get(`/api/photos/${token}`);
      await new Promise((r) => setTimeout(r, 30));
    } finally { spy.mockRestore(); delete process.env.LOG_IN_TESTS; }
    const text = lines.join('');
    expect(text).toContain('"path":"/api/photos/:token"');
    expect(text).not.toContain(token);
    expect(text).not.toContain(token.split('.')[0]);
  });
});
