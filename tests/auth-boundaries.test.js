// Calling the API directly, the way someone bypassing the screens would. Role, school and session are decided on the server.
const jwt = require('jsonwebtoken');
const { api, connect, disconnect, clear, auth, tokenFor, makeUser, seedSchool } = require('./helpers');
const User = require('../src/models/User');
const Student = require('../src/models/Student');
const { hashPassword } = require('../src/services/credentials');

let A;
let B;
beforeAll(connect);
afterAll(disconnect);
beforeEach(async () => {
  await clear();
  A = await seedSchool('Alpha School');
  B = await seedSchool('Beta School');
});

const bearer = (t) => ({ Authorization: `Bearer ${t}` });

async function platformOwner() {
  const user = await User.create({ name: 'Owner', email: `owner${Date.now()}@eduamigo.test`, password: await hashPassword('OwnerPass123'), role: 'superadmin' });
  const login = await api().post('/api/platform/login').send({ email: user.email, password: 'OwnerPass123' });
  return { user, token: login.body.token };
}

describe('role limits', () => {
  test('a student cannot do the office\'s work', async () => {
    expect((await api().post('/api/students').set(auth(A.studentUser)).send({ name: 'X', class: '10', section: 'A' })).status).toBe(403);
    expect((await api().get('/api/users').set(auth(A.studentUser))).status).toBe(403);
    expect((await api().post('/api/users/register').set(auth(A.studentUser)).send({ name: 'X', email: 'x@y.test', role: 'admin' })).status).toBe(403);
    expect((await api().get('/api/audit').set(auth(A.studentUser))).status).toBe(403);
  });

  test('a teacher and a parent cannot reach administration either', async () => {
    for (const user of [A.teacherUser, A.parentUser]) {
      expect((await api().get('/api/users').set(auth(user))).status).toBe(403);
      expect((await api().post('/api/users/register').set(auth(user)).send({ name: 'X', email: 'x@y.test', role: 'admin' })).status).toBe(403);
      expect((await api().get('/api/hr/salaries').set(auth(user))).status).toBe(403);
      expect((await api().get('/api/audit').set(auth(user))).status).toBe(403);
    }
  });

  test('a school admin cannot create a platform account or reach the platform', async () => {
    expect((await api().post('/api/users/register').set(auth(A.admin)).send({ name: 'Boss', email: 'boss@y.test', role: 'superadmin' })).status).toBe(400);
    expect(await User.countDocuments({ role: 'superadmin' })).toBe(0);
    for (const path of ['/api/platform/me', '/api/platform/schools', '/api/platform/stats', '/api/platform/audit']) {
      expect((await api().get(path).set(auth(A.admin))).status).toBe(403);
    }
    expect((await api().patch(`/api/platform/schools/${A.school._id}/subscription`).set(auth(A.admin)).send({ plan: 'premium' })).status).toBe(403);
  });
});

describe('school limits', () => {
  test('a school admin cannot read or change another school\'s students, even by id', async () => {
    const theirs = await Student.findOne({ school: B.school._id });
    expect((await api().get(`/api/students/${theirs._id}`).set(auth(A.admin))).status).toBe(404);
    expect((await api().put(`/api/students/${theirs._id}`).set(auth(A.admin)).send({ name: 'Hacked' })).status).toBe(404);
    expect((await api().delete(`/api/students/${theirs._id}`).set(auth(A.admin))).status).toBe(404);
    expect((await Student.findById(theirs._id)).name).not.toBe('Hacked');
    const list = await api().get('/api/students').set(auth(A.admin));
    expect(JSON.stringify(list.body)).not.toContain(String(theirs._id));
  });

  test('a school id sent by the client changes nothing', async () => {
    const res = await api().get(`/api/students?school=${B.school._id}&schoolId=${B.school._id}`).set(auth(A.admin)).set('X-School-Id', String(B.school._id));
    expect(res.status).toBe(200);
    const ids = res.body.data.map((s) => String(s.school));
    expect(ids.every((id) => id === String(A.school._id))).toBe(true);
    const created = await api().post('/api/students').set(auth(A.admin)).send({ name: 'Riya', phone: '9811111111', class: '10', section: 'A', school: String(B.school._id) });
    expect(created.status).toBe(201);
    expect(String((await Student.findOne({ name: 'Riya' })).school)).toBe(String(A.school._id));
  });

  test('a parent sees only their own children, a student only themselves', async () => {
    const other = await Student.findOne({ school: A.school._id, name: 'Diya' });
    expect((await api().get(`/api/students/${other._id}`).set(auth(A.parentUser))).status).toBeGreaterThanOrEqual(403);
    expect((await api().get(`/api/students/${other._id}`).set(auth(A.studentUser))).status).toBeGreaterThanOrEqual(403);
  });
});

describe('platform owner (Super Admin)', () => {
  test('is a separate kind of account: it works on the platform and nowhere in a school', async () => {
    const { token } = await platformOwner();
    expect((await api().get('/api/platform/me').set(bearer(token))).status).toBe(200);
    for (const path of ['/api/users/profile', '/api/students', '/api/fees', '/api/users']) {
      expect((await api().get(path).set(bearer(token))).status).toBe(401);
    }
  });

  test('without a platform token there is no access, and a school token is not a platform token', async () => {
    expect((await api().get('/api/platform/schools')).status).toBe(401);
    expect((await api().get('/api/platform/schools').set(bearer('not.a.token'))).status).toBe(401);
    expect((await api().get('/api/platform/schools').set(auth(A.teacherUser))).status).toBe(403);
  });

  test('a school account cannot sign in at the platform, and a platform account cannot sign in at a school', async () => {
    const asSchool = await api().post('/api/platform/login').send({ email: A.admin.email, password: 'Password123' });
    expect(asSchool.status).toBe(401);
    expect(asSchool.body.token).toBeUndefined();
    const { user } = await platformOwner();
    expect((await api().post('/api/users/login').send({ identifier: user.email, password: 'OwnerPass123' })).status).toBe(401);
  });

  test('turning a school admin into a platform owner through the token does nothing', async () => {
    const forged = jwt.sign({ id: A.admin._id, role: 'superadmin', scope: 'platform' }, process.env.JWT_SECRET, { expiresIn: '1h' });
    expect((await api().get('/api/platform/me').set(bearer(forged))).status).toBe(401); // the database says admin, not superadmin
  });

  test('a deactivated owner is out at once', async () => {
    const { user, token } = await platformOwner();
    await User.updateOne({ _id: user._id }, { isActive: false });
    expect((await api().get('/api/platform/me').set(bearer(token))).status).toBe(401);
  });
});

describe('sessions', () => {
  test('no token, a bad token, a token signed with another secret and an expired token are all refused', async () => {
    expect((await api().get('/api/users/profile')).status).toBe(401);
    expect((await api().get('/api/users/profile').set(bearer('x.y.z'))).status).toBe(401);
    const wrongSecret = jwt.sign({ id: A.admin._id, role: 'admin' }, 'another-secret-another-secret-another', { expiresIn: '1h' });
    expect((await api().get('/api/users/profile').set(bearer(wrongSecret))).status).toBe(401);
    const expired = jwt.sign({ id: A.admin._id, role: 'admin' }, process.env.JWT_SECRET, { expiresIn: -60 });
    const res = await api().get('/api/users/profile').set(bearer(expired));
    expect(res.status).toBe(401);
    expect(res.body.message).toMatch(/expired/i);
  });

  test('logging out everywhere ends every session, including a copy of the token', async () => {
    const login = await api().post('/api/users/login').send({ identifier: A.admin.email, password: 'Password123' });
    const token = login.body.token;
    expect((await api().get('/api/users/profile').set(bearer(token))).status).toBe(200);
    expect((await api().post('/api/users/logout-all').set(bearer(token))).status).toBe(200);
    expect((await api().get('/api/users/profile').set(bearer(token))).status).toBe(401);
  });

  test('a changed password ends the older sessions, and the new token it returns works', async () => {
    // A session started an hour ago (for example on a lost phone). A token issued within the same second as the change is
    // deliberately kept, so the token returned by the change itself is never cut off.
    const hourAgo = Math.floor(Date.now() / 1000) - 3600;
    const old = jwt.sign({ id: A.teacherUser._id, role: 'teacher', v: 0, iat: hourAgo }, process.env.JWT_SECRET, { expiresIn: '7d' });
    expect((await api().get('/api/users/profile').set(bearer(old))).status).toBe(200);
    const changed = await api().patch('/api/users/password').set(bearer(old)).send({ currentPassword: 'Password123', newPassword: 'Another#Pass99' });
    expect(changed.status).toBe(200);
    expect((await api().get('/api/users/profile').set(bearer(old))).status).toBe(401);
    expect((await api().get('/api/users/profile').set(bearer(changed.body.token))).status).toBe(200);
  });

  test('a deactivated account is out at once', async () => {
    const fresh = await makeUser(A.school, 'teacher');
    const t = tokenFor(fresh);
    expect((await api().get('/api/users/profile').set(bearer(t))).status).toBe(200);
    await User.updateOne({ _id: fresh._id }, { isActive: false });
    expect((await api().get('/api/users/profile').set(bearer(t))).status).toBe(401);
  });
});

describe('class timetables', () => {
  const Timetable = require('../src/models/Timetable');
  beforeEach(async () => {
    await Timetable.create([
      { school: A.school._id, class: '10', section: 'A', day: 'Monday', periods: [{ no: 1, subject: 'Mathematics', startTime: '09:00', endTime: '09:45' }] },
      { school: A.school._id, class: '10', section: 'B', day: 'Monday', periods: [{ no: 1, subject: 'Science', startTime: '09:00', endTime: '09:45' }] },
    ]);
  });
  const get = (user, path) => api().get(path).set(auth(user));

  test('a parent reads the timetable of their child\'s class and no other class', async () => {
    const own = await get(A.parentUser, '/api/timetable/class/10/Monday?section=A');
    expect(own.status).toBe(200);
    expect(own.body.data.periods[0].subject).toBe('Mathematics');
    expect((await get(A.parentUser, '/api/timetable/class/10/Monday?section=B')).status).toBe(403);
    expect((await get(A.parentUser, '/api/timetable/class/10?section=B')).status).toBe(403);
    expect((await get(A.parentUser, '/api/timetable/class/7/Monday?section=A')).status).toBe(403);
  });

  test('a student reads their own class and no other', async () => {
    expect((await get(A.studentUser, '/api/timetable/class/10/Monday?section=A')).status).toBe(200);
    expect((await get(A.studentUser, '/api/timetable/class/10/Monday?section=B')).status).toBe(403);
  });

  test('teachers and the office still read any class', async () => {
    expect((await get(A.teacherUser, '/api/timetable/class/10/Monday?section=B')).status).toBe(200);
    expect((await get(A.admin, '/api/timetable/class/10/Monday?section=B')).status).toBe(200);
  });
});
