// Profile photos for every role: a student's photo is the one on the student record, everyone else's is on their account.
process.env.PHOTO_STORAGE = 'local';
process.env.PHOTO_LOCAL_DIR = require('path').join(require('os').tmpdir(), `eduamigo-avatars-${process.pid}`);

const jwt = require('jsonwebtoken');
const { api, connect, disconnect, clear, auth, seedSchool } = require('./helpers');
const Student = require('../src/models/Student');
const User = require('../src/models/User');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const upload = (user, buf = PNG, type = 'image/png') => api().put('/api/users/me/avatar').set(auth(user)).attach('photo', buf, { filename: 'me.png', contentType: type });
const linkPath = (url) => url.replace(/^https?:\/\/[^/]+/, '');

let A;
beforeAll(connect);
afterAll(disconnect);
beforeEach(async () => { await clear(); A = await seedSchool('Alpha School'); });

describe('profile photo', () => {
  test.each([['admin', 'admin'], ['teacher', 'teacherUser'], ['parent', 'parentUser']])('a %s sets, sees and removes their photo', async (_role, key) => {
    const user = A[key];
    const res = await upload(user);
    
    expect(res.status).toBe(200);
    expect(res.body.avatar).toMatch(/\/api\/photos\//);
    const stored = await User.findById(user._id);
    expect(stored.avatarKey).toMatch(new RegExp(`^eduamigo/${A.school._id}/avatars/[a-f0-9]{32}$`));
    const me = await api().get('/api/users/profile').set(auth(user));
    expect(me.body.data.avatar).toMatch(/\/api\/photos\//);
    expect(JSON.stringify(me.body)).not.toMatch(/avatarKey|eduamigo\//);
    const img = await api().get(linkPath(me.body.data.avatar));
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');
    const del = await api().delete('/api/users/me/avatar').set(auth(user));
    expect(del.status).toBe(200);
    expect((await api().get('/api/users/profile').set(auth(user))).body.data.avatar).toBeUndefined();
    expect((await api().get(linkPath(me.body.data.avatar))).status).toBe(404);
  });

  test('a student\'s photo is saved on the student record, so lists and the ID card show it too', async () => {
    const res = await upload(A.studentUser);
    expect(res.status).toBe(200);
    const student = await Student.findById(A.student._id);
    expect(student.photoKey).toMatch(new RegExp(`^eduamigo/${A.school._id}/students/`));
    const list = await api().get('/api/students').set(auth(A.admin));
    const row = (list.body.data || list.body.students || []).find((s) => String(s._id) === String(A.student._id));
    expect(row.photo).toMatch(/\/api\/photos\//);
    const me = await api().get('/api/users/profile').set(auth(A.studentUser));
    expect(me.body.data.avatar).toMatch(/\/api\/photos\//);
  });

  test('a teacher\'s own photo shows in the teacher list', async () => {
    await upload(A.teacherUser);
    const list = await api().get('/api/teachers').set(auth(A.admin));
    expect(list.body.data[0].photo).toMatch(/\/api\/photos\//);
  });

  test('replacing a photo removes the old one', async () => {
    await upload(A.admin);
    const first = (await User.findById(A.admin._id)).avatarKey;
    await upload(A.admin);
    const second = (await User.findById(A.admin._id)).avatarKey;
    expect(second).not.toBe(first);
    const old = await api().get(`/api/photos/${require('../src/services/photos').createToken(first)}`);
    expect(old.status).toBe(404);
  });

  test('files that are not images, and missing files, are refused', async () => {
    expect((await upload(A.admin, Buffer.from('<script>alert(1)</script>'), 'image/png')).status).toBe(400);
    expect((await api().put('/api/users/me/avatar').set(auth(A.admin))).status).toBe(400);
    expect((await api().put('/api/users/me/avatar')).status).toBe(401);
  });

  test('sessions last 24 hours', async () => {
    const login = await api().post('/api/users/login').send({ email: A.admin.email, password: 'Password123' });
    const { exp, iat } = jwt.decode(login.body.token);
    expect(exp - iat).toBe(24 * 3600);
  });
});
