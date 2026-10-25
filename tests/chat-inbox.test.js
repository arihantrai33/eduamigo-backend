// The chat screen's backend: one inbox per role, files and voice notes in messages, and concerns the school raises with parents.
process.env.PHOTO_STORAGE = 'local';
process.env.PHOTO_LOCAL_DIR = require('path').join(require('os').tmpdir(), `eduamigo-chat-${process.pid}`);

const { api, connect, disconnect, clear, auth, seedSchool } = require('./helpers');
const Complaint = require('../src/models/Complaint');
const Message = require('../src/models/Message');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(64, 2)]);
const path = (url) => url.replace(/^https?:\/\/[^/]+/, '');

let A; let B;
beforeAll(connect);
afterAll(disconnect);
beforeEach(async () => { await clear(); A = await seedSchool('Alpha School'); B = await seedSchool('Beta School'); });

const send = (from, to, fields = {}, file) => {
  let r = api().post('/api/chat/messages').set(auth(from)).field('receiverId', String(to._id));
  for (const [k, v] of Object.entries(fields)) r = r.field(k, v);
  return file ? r.attach('files', file.buf, { filename: file.name, contentType: file.type }) : r;
};

describe('inbox', () => {
  test('a parent sees the school and the teachers of the child\'s class; a student the same; nobody sees another school', async () => {
    const parent = (await api().get('/api/chat/inbox').set(auth(A.parentUser))).body.data;
    expect(parent.map((p) => p.role).sort()).toEqual(['admin', 'teacher']);
    expect(parent.every((p) => p.roomId && p.userId && p.subtitle)).toBe(true);
    const student = (await api().get('/api/chat/inbox').set(auth(A.studentUser))).body.data;
    expect(student.map((p) => p.role).sort()).toEqual(['admin', 'teacher']);
    expect(JSON.stringify(parent)).not.toContain(String(B.admin._id));
  });

  test('a teacher sees the office, the students and the parents of their classes only', async () => {
    const list = (await api().get('/api/chat/inbox').set(auth(A.teacherUser))).body.data;
    expect(list.filter((p) => p.role === 'student').map((p) => p.name)).toEqual(['Aarav']); // not Diya of 10-B
    expect(list.some((p) => p.role === 'parent' && /Aarav/.test(p.subtitle))).toBe(true);
    expect(list.some((p) => p.role === 'admin')).toBe(true);
  });

  test('the office sees teachers, parents and students; most recent chat first, with unread counts and a preview', async () => {
    await send(A.parentUser, A.admin, { text: 'Hello office' });
    await send(A.teacherUser, A.admin, { text: 'Later message' });
    const list = (await api().get('/api/chat/inbox').set(auth(A.admin))).body.data;
    expect(list[0]).toMatchObject({ name: A.teacherUser.name, unread: 1, lastMsg: 'Later message' });
    expect(list[1]).toMatchObject({ unread: 1, lastMsg: 'Hello office' });
    expect(list.some((p) => p.role === 'student')).toBe(true);
  });

  test('profile photos show in the inbox', async () => {
    await api().put('/api/users/me/avatar').set(auth(A.teacherUser)).attach('photo', PNG, { filename: 'a.png', contentType: 'image/png' });
    const list = (await api().get('/api/chat/inbox').set(auth(A.parentUser))).body.data;
    expect(list.find((p) => p.role === 'teacher').avatar).toMatch(/\/api\/photos\//);
  });
});

describe('files in messages', () => {
  test('a photo and a voice note are sent, shown with private links, and the last-message line says what they are', async () => {
    const photo = await send(A.parentUser, A.teacherUser, {}, { buf: PNG, name: 'homework.png', type: 'image/png' });
    expect(photo.status).toBe(201);
    expect(photo.body.data.attachments[0]).toMatchObject({ name: 'homework.png', kind: 'image', type: 'image/png' });
    expect(JSON.stringify(photo.body)).not.toMatch(/eduamigo\/|"key"/);
    const voice = await send(A.parentUser, A.teacherUser, { text: '' }, { buf: WEBM, name: 'voice.webm', type: 'audio/webm' });
    expect(voice.status).toBe(201);
    expect(voice.body.data.attachments[0].kind).toBe('audio');
    const room = voice.body.data.roomId;
    const msgs = (await api().get(`/api/chat/messages/${room}`).set(auth(A.teacherUser))).body.data;
    expect(msgs).toHaveLength(2);
    const img = await api().get(path(msgs[0].attachments[0].url));
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');
    const inbox = (await api().get('/api/chat/inbox').set(auth(A.teacherUser))).body.data;
    expect(inbox.find((p) => p.role === 'parent').lastMsg).toBe('Voice message');
  });

  test('scripts and unknown files are refused, and the old text-only way still works', async () => {
    expect((await send(A.parentUser, A.teacherUser, {}, { buf: Buffer.from('<script>alert(1)</script>'), name: 'x.html', type: 'text/html' })).status).toBe(400);
    expect((await send(A.parentUser, A.teacherUser, { text: 'Hi' })).status).toBe(201);
    expect((await send(A.parentUser, A.teacherUser, { text: '' })).status).toBe(400);
    expect(await Message.countDocuments()).toBe(1);
  });
});

describe('concerns raised by the school', () => {
  const raise = (user, fields = {}) => api().post('/api/complaints').set(auth(user)).send({ studentId: String(A.student._id), category: 'Behaviour', subject: 'Talking in class', details: 'Three times this week', ...fields });

  test('a teacher raises one for a student of their class; the parent is told, sees it, replies; the school closes it', async () => {
    const res = await raise(A.teacherUser);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ category: 'Behaviour', status: 'open', raisedBy: A.teacherUser.name });
    const mine = await api().get('/api/complaints/child').set(auth(A.parentUser));
    expect(mine.body.data).toHaveLength(1);
    const id = mine.body.data[0]._id;
    const rep = await api().post(`/api/complaints/${id}/reply`).set(auth(A.parentUser)).send({ text: 'I will talk to him' });
    expect(rep.body.data).toMatchObject({ status: 'acknowledged' });
    expect(rep.body.data.responses).toHaveLength(1);
    const done = await api().patch(`/api/complaints/${id}`).set(auth(A.teacherUser)).send({ status: 'resolved' });
    expect(done.body.data).toMatchObject({ status: 'resolved' });
    expect((await api().patch(`/api/complaints/${id}`).set(auth(A.parentUser)).send({ status: 'open' })).status).toBe(403);
  });

  test('a teacher cannot raise one for another class, a parent cannot raise one, and other families and schools see nothing', async () => {
    expect((await raise(A.teacherUser, { studentId: String(A.otherStudent._id) })).status).toBe(404);
    expect((await raise(A.parentUser)).status).toBe(403);
    expect((await raise(A.teacherUser, { subject: '' })).status).toBe(400);
    const c = (await raise(A.teacherUser)).body.data;
    expect((await api().get('/api/complaints/child').set(auth(B.parentUser))).body.data).toHaveLength(0);
    expect((await api().post(`/api/complaints/${c._id}/reply`).set(auth(B.parentUser)).send({ text: 'x' })).status).toBe(404);
    expect((await api().get('/api/complaints').set(auth(B.admin))).body.data).toHaveLength(0);
    expect((await api().get('/api/complaints').set(auth(A.admin))).body.data).toHaveLength(1);
    expect(await Complaint.countDocuments()).toBe(1);
  });
});
