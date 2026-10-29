const { api, connect, disconnect, clear, auth, seedSchool, makeUser, scheduleExam } = require('./helpers');
const User = require('../src/models/User');
const Student = require('../src/models/Student');
const Transport = require('../src/models/Transport');

let A;
let B;

beforeAll(connect);
afterAll(disconnect);
beforeEach(async () => {
  await clear();
  A = await seedSchool('Alpha School');
  B = await seedSchool('Beta School');
});

describe('authentication', () => {
  test('public registration is not possible', async () => {
    const res = await api().post('/api/users/register').send({ name: 'x', email: 'x@x.com', password: 'Password123', role: 'admin' });
    expect(res.status).toBe(401);
  });

  test('non-admins cannot create accounts', async () => {
    const res = await api().post('/api/users/register').set(auth(A.teacherUser))
      .send({ name: 'x', email: 'x@x.com', role: 'admin' });
    expect(res.status).toBe(403);
  });

  test('admin-created users always belong to the admin\'s school', async () => {
    const res = await api().post('/api/users/register').set(auth(A.admin))
      .send({ name: 'New Accountant', email: 'new@x.com', role: 'accountant', school: String(B.school._id) });
    expect(res.status).toBe(201);
    expect(res.body.credentials.password).toBeTruthy();
    const user = await User.findOne({ email: 'new@x.com' });
    expect(String(user.school)).toBe(String(A.school._id));
    expect(user.mustChangePassword).toBe(true);
  });

  test('login uses one generic error for unknown email and wrong password', async () => {
    const unknown = await api().post('/api/users/login').send({ email: 'nobody@x.com', password: 'whatever1' });
    const wrong = await api().post('/api/users/login').send({ email: A.admin.email, password: 'wrongpass1' });
    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(unknown.body.message).toBe(wrong.body.message);
  });

  test('login works and returns the school', async () => {
    const res = await api().post('/api/users/login').send({ email: A.admin.email, password: 'Password123' });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    expect(res.body.user.school).toBe('Alpha School');
  });

  test('deactivated users cannot log in or use an old token', async () => {
    await User.updateOne({ _id: A.teacherUser._id }, { isActive: false });
    const login = await api().post('/api/users/login').send({ email: A.teacherUser.email, password: 'Password123' });
    expect(login.status).toBe(403);
    const me = await api().get('/api/users/profile').set(auth(A.teacherUser));
    expect(me.status).toBe(401);
  });

  test('password change invalidates older tokens', async () => {
    const headers = auth(A.admin);
    await new Promise((r) => setTimeout(r, 1100));
    const res = await api().patch('/api/users/password').set(headers).send({ currentPassword: 'Password123', newPassword: 'NewPassword456' });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 1100));
    const old = await api().get('/api/users/profile').set(headers);
    expect(old.status).toBe(401);
    const fresh = await api().get('/api/users/profile').set({ Authorization: `Bearer ${res.body.token}` });
    expect(fresh.status).toBe(200);
  });

  test('students, parents and teachers cannot be created as bare logins', async () => {
    const res = await api().post('/api/users/register').set(auth(A.admin)).send({ name: 'x', email: 'bare@x.com', role: 'student' });
    expect(res.status).toBe(400);
  });

  test('admins only see users of their own school', async () => {
    const res = await api().get('/api/users').set(auth(A.admin));
    expect(res.status).toBe(200);
    const schools = new Set(res.body.data.map((u) => String(u.school._id)));
    expect([...schools]).toEqual([String(A.school._id)]);
  });

  test('admins cannot toggle users of another school', async () => {
    const res = await api().patch(`/api/users/${B.teacherUser._id}/toggle`).set(auth(A.admin));
    expect(res.status).toBe(404);
  });
});

describe('role guards', () => {
  const studentCalls = [
    ['get', '/api/hr/salaries'],
    ['post', '/api/bulk/promote'],
    ['post', '/api/announcements'],
    ['post', '/api/notifications/send'],
    ['post', '/api/events'],
    ['get', '/api/fees'],
    ['get', '/api/users'],
  ];
  test.each(studentCalls)('student gets 403 for %s %s', async (method, url) => {
    const res = await api()[method](url).set(auth(A.studentUser)).send({});
    expect(res.status).toBe(403);
  });

  test.each([
    ['get', '/api/exams/results'],
    ['get', `/api/exams/student/000000000000000000000000/results`],
    ['get', '/api/attendance/today'],
    ['get', '/api/notifications/my'],
  ])('unauthenticated %s %s is rejected', async (method, url) => {
    const res = await api()[method](url);
    expect(res.status).toBe(401);
  });

  test('legacy unauthenticated exam result write endpoint is gone', async () => {
    const res = await api().post('/api/exams/result').send({ studentId: String(A.student._id), subject: 'x', marks: 1, maxMarks: 1 });
    expect([401, 404]).toContain(res.status);
  });
});

describe('tenant isolation', () => {
  test('students list is scoped to the school', async () => {
    const res = await api().get('/api/students').set(auth(A.admin));
    expect(res.body.data.every((s) => String(s.school) === String(A.school._id))).toBe(true);
    expect(res.body.data).toHaveLength(2);
  });

  test('cannot read a student of another school by id', async () => {
    const res = await api().get(`/api/students/${B.student._id}`).set(auth(A.admin));
    expect(res.status).toBe(404);
  });

  test('announcements stay inside their school', async () => {
    await api().post('/api/announcements').set(auth(A.admin)).send({ title: 'Alpha only', message: 'Hello' }).expect(201);
    const mine = await api().get('/api/announcements/my').set(auth(A.studentUser));
    const other = await api().get('/api/announcements/my').set(auth(B.studentUser));
    expect(mine.body.data).toHaveLength(1);
    expect(other.body.data).toHaveLength(0);
  });

  test('bulk promote only moves students of the admin\'s own school', async () => {
    const res = await api().post('/api/bulk/promote').set(auth(A.admin))
      .send({ fromClass: '10', fromSection: 'A', toClass: '11', toSection: 'A' });
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    const bStudent = await Student.findById(B.student._id);
    expect(bStudent.class).toBe('10');
  });

  test('teachers only see students of their assigned classes', async () => {
    const res = await api().get('/api/students').set(auth(A.teacherUser));
    expect(res.status).toBe(200);
    expect(res.body.data.map((s) => s.name)).toEqual(['Aarav']);
  });
});

describe('notification privacy', () => {
  async function publishMathMarks(ctx) {
    const exam = await scheduleExam(ctx, { title: 'Unit Test 1', totalMarks: 50 });
    await api().post('/api/marks/save').set(auth(ctx.teacherUser))
      .send({ examId: String(exam._id), marksData: [{ studentId: String(ctx.student._id), marksObtained: 42 }] }).expect(200);
    await api().patch('/api/marks/publish').set(auth(ctx.teacherUser)).send({ examId: String(exam._id) }).expect(200);
  }

  test('a child\'s result reaches only that child and their parent', async () => {
    await publishMathMarks(A);
    const parent = await api().get('/api/notifications/my').set(auth(A.parentUser));
    const student = await api().get('/api/notifications/my').set(auth(A.studentUser));
    const otherStudent = await api().get('/api/notifications/my').set(auth(A.otherStudentUser));
    const otherSchoolParent = await api().get('/api/notifications/my').set(auth(B.parentUser));

    expect(parent.body.data.some((n) => n.message.includes('42/50'))).toBe(true);
    expect(student.body.data.some((n) => n.message.includes('42/50'))).toBe(true);
    expect(otherStudent.body.data).toHaveLength(0);
    expect(otherSchoolParent.body.data).toHaveLength(0);
  });

  test('another parent in the same school does not see the notification', async () => {
    const strangerParent = await makeUser(A.school, 'parent');
    await publishMathMarks(A);
    const res = await api().get('/api/notifications/my').set(auth(strangerParent));
    expect(res.body.data).toHaveLength(0);
  });
});

describe('chat', () => {
  test('a user cannot read a conversation they are not part of', async () => {
    await api().post('/api/chat/messages').set(auth(A.parentUser))
      .send({ receiverId: String(A.teacherUser._id), text: 'Private message' }).expect(201);
    const roomId = [String(A.parentUser._id), String(A.teacherUser._id)].sort().join('_');
    const intruder = await api().get(`/api/chat/messages/${roomId}`).set(auth(A.otherStudentUser));
    expect(intruder.status).toBe(403);
    const teacher = await api().get(`/api/chat/messages/${roomId}`).set(auth(A.teacherUser));
    expect(teacher.body.data[0].text).toBe('Private message');
  });

  test('cannot message users of another school', async () => {
    const res = await api().post('/api/chat/messages').set(auth(A.parentUser))
      .send({ receiverId: String(B.teacherUser._id), text: 'hi' });
    expect(res.status).toBe(404);
  });

  test('students cannot message other students directly', async () => {
    const res = await api().post('/api/chat/messages').set(auth(A.studentUser))
      .send({ receiverId: String(A.otherStudentUser._id), text: 'hi' });
    expect(res.status).toBe(403);
  });
});

describe('transport', () => {
  test('parents get the bus id to watch, never the driver token', async () => {
    const bus = await api().post('/api/transport').set(auth(A.admin))
      .send({ busNumber: 'DL 1 AB 1234', driverName: 'Ram', driverPhone: '9999999999', routeName: 'North' });
    expect(bus.status).toBe(201);
    await api().put(`/api/transport/${bus.body.data._id}/assign-students`).set(auth(A.admin))
      .send({ studentIds: [String(A.student._id)] }).expect(200);

    const res = await api().get('/api/transport/my-child-bus').set(auth(A.parentUser));
    expect(res.status).toBe(200);
    const stored = await Transport.findById(bus.body.data._id);
    expect(res.body.data.busId).toBe(String(stored._id));
    expect(res.body.data.firebasePath).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain(stored.driverToken);
    expect(stored.driverToken.length).toBeGreaterThan(20);
  });

  test('cannot assign students from another school to a bus', async () => {
    const bus = await api().post('/api/transport').set(auth(A.admin))
      .send({ busNumber: 'B1', driverName: 'Ram', driverPhone: '9', routeName: 'N' });
    const res = await api().put(`/api/transport/${bus.body.data._id}/assign-students`).set(auth(A.admin))
      .send({ studentIds: [String(B.student._id)] });
    expect(res.status).toBe(400);
  });
});

describe('SOS', () => {
  test('parent SOS reaches the school admins only, and is throttled', async () => {
    // A location sent by the phone is ignored (the server uses its own last reading of the bus); a retry with the same requestId is one event.
    const res = await api().post('/api/transport/sos').set(auth(A.parentUser)).send({ lat: 28.6, lng: 77.2, requestId: 'sos-test-0001' });
    expect(res.status).toBe(201);
    expect(res.body.notified).toBe(1);
    expect(res.body.delivery).toEqual({ inApp: 'created', push: 'unconfirmed', driver: 'not_notified' });
    const SosEvent = require('../src/models/SosEvent');
    const saved = await SosEvent.findById(res.body.eventId).lean();
    expect(String(saved.school)).toBe(String(A.school._id));
    expect(String(saved.createdBy)).toBe(String(A.parentUser._id));
    expect(saved.driverNotified).toBe(false);
    expect(saved.recipients).toHaveLength(1);
    expect(saved.busPosition).toBeUndefined();
    const admin = await api().get('/api/notifications/my').set(auth(A.admin));
    expect(admin.body.data[0].title).toBe('SOS alert');
    expect(admin.body.data[0].message).toContain('Aarav');
    const otherAdmin = await api().get('/api/notifications/my').set(auth(B.admin));
    expect(otherAdmin.body.data).toHaveLength(0);
    expect(admin.body.data[0].message).not.toContain('28.6');
    const again = await api().post('/api/transport/sos').set(auth(A.parentUser)).send({});
    expect(again.status).toBe(429);
    const retry = await api().post('/api/transport/sos').set(auth(A.parentUser)).send({ requestId: 'sos-test-0001' });
    expect(retry.status).toBe(200);
    expect(retry.body.duplicate).toBe(true);
    expect(retry.body.eventId).toBe(res.body.eventId);
    expect(await SosEvent.countDocuments({ school: A.school._id })).toBe(1);
    const notes = await api().get('/api/notifications/my').set(auth(A.admin));
    expect(notes.body.data.filter((n) => n.title === 'SOS alert')).toHaveLength(1);
    // another school's family cannot reuse the id to read or create anything in this school
    const other = await api().post('/api/transport/sos').set(auth(B.parentUser || B.admin)).send({ requestId: 'sos-test-0001' });
    expect([201, 403, 404]).toContain(other.status);
    expect(await SosEvent.countDocuments({ school: A.school._id })).toBe(1);
  });
});

describe('SOS hardening', () => {
  test('two copies of one tap at the same moment are one event and one alert', async () => {
    const SosEvent = require('../src/models/SosEvent');
    const body = { requestId: 'sos-race-0001' };
    const [x, y] = await Promise.all([
      api().post('/api/transport/sos').set(auth(B.parentUser)).send(body),
      api().post('/api/transport/sos').set(auth(B.parentUser)).send(body),
    ]);
    expect([x.status, y.status].sort()).toEqual([200, 201]);
    expect(x.body.eventId).toBe(y.body.eventId);
    expect(await SosEvent.countDocuments({ school: B.school._id })).toBe(1);
    const notes = await api().get('/api/notifications/my').set(auth(B.admin));
    expect(notes.body.data.filter((n) => n.title === 'SOS alert')).toHaveLength(1);
  });

  test('the limit holds without any admin to notify, and a staff role cannot raise one', async () => {
    const User = require('../src/models/User');
    const SosEvent = require('../src/models/SosEvent');
    await User.updateMany({ school: B.school._id, role: 'admin' }, { isActive: false });
    const first = await api().post('/api/transport/sos').set(auth(B.parentUser)).send({});
    expect(first.status).toBe(201);
    expect(first.body.notified).toBe(0);
    expect(first.body.delivery.inApp).toBe('none'); // saved, but nobody was told: the app says so
    const second = await api().post('/api/transport/sos').set(auth(B.parentUser)).send({});
    expect(second.status).toBe(429);
    expect(await SosEvent.countDocuments({ school: B.school._id })).toBe(1);
    const staff = await api().post('/api/transport/sos').set(auth(B.teacherUser || B.admin)).send({});
    expect(staff.status).toBe(403);
    await User.updateMany({ school: B.school._id, role: 'admin' }, { isActive: true });
  });
});

describe('chat contact lists', () => {
  test('admin and teacher inboxes show unread counts and the last message', async () => {
    await api().post('/api/chat/messages').set(auth(A.parentUser)).send({ receiverId: String(A.admin._id), text: 'First' }).expect(201);
    await new Promise((r) => setTimeout(r, 20));
    await api().post('/api/chat/messages').set(auth(A.parentUser)).send({ receiverId: String(A.admin._id), text: 'Latest' }).expect(201);
    const admin = await api().get('/api/chat/admin-contacts').set(auth(A.admin));
    expect(admin.status).toBe(200);
    const parent = admin.body.data.find((c) => String(c.userId) === String(A.parentUser._id));
    expect(parent.unread).toBe(2);
    expect(parent.lastMsg).toBe('Latest');
    const teacher = await api().get('/api/chat/teacher-contacts').set(auth(A.teacherUser));
    expect(teacher.status).toBe(200);
    expect(teacher.body.data.map((c) => c.type).sort()).toEqual(['parent', 'student']);
  });

  test('a parent with two children in the teacher\'s class is one contact naming both children', async () => {
    const sibling = await Student.create({
      name: 'Sibling', phone: '9000000010', rollNumber: '2', class: '10', section: 'A', school: A.school._id,
      userId: (await makeUser(A.school, 'student'))._id, parentUserId: A.parentUser._id,
    });
    const res = await api().get('/api/chat/teacher-contacts').set(auth(A.teacherUser));
    const parents = res.body.data.filter((c) => c.type === 'parent');
    expect(parents).toHaveLength(1);
    expect(parents[0].childName).toBe(`${A.student.name}, ${sibling.name}`);
    const keys = res.body.data.map((c) => `${c.type}-${c.userId}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
