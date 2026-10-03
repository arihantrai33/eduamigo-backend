const { api, connect, disconnect, clear, auth, seedSchool } = require('./helpers');
const User = require('../src/models/User');
const School = require('../src/models/School');
const Student = require('../src/models/Student');
const Admission = require('../src/models/Admission');
const PasswordReset = require('../src/models/PasswordReset');
const email = require('../src/services/email');
const { hashPassword } = require('../src/services/credentials');
const { migrate } = require('../src/scripts/migrate');

let A;
let B;
let sendSpy;

beforeAll(connect);
afterAll(disconnect);
beforeEach(async () => {
  await clear();
  A = await seedSchool('Alpha School');   // code ALP
  B = await seedSchool('Beta School');    // code BET
  sendSpy = jest.spyOn(email, 'sendEmail').mockResolvedValue({ delivered: true });
});
afterEach(() => sendSpy.mockRestore());

const login = (body) => api().post('/api/users/login').send(body);
const bearer = (token) => ({ Authorization: `Bearer ${token}` });
const codeFromEmail = () => /code is: (\d{6})/.exec(sendSpy.mock.calls.at(-1)[0].text)[1];

async function addStudent(ctx, extra = {}) {
  const res = await api().post('/api/students').set(auth(ctx.admin)).send({ name: 'Riya', phone: '9811111111', class: '10', section: 'A', ...extra });
  expect(res.status).toBe(201);
  return res.body;
}

describe('students sign in with the school code and admission number', () => {
  test('a student without email gets a login and signs in with the admission number', async () => {
    const { data, credentials } = await addStudent(A);
    expect(data.email).toBeUndefined();
    expect(credentials.student).toMatchObject({ schoolCode: 'ALP', loginId: data.admissionNo, email: null });

    const res = await login({ schoolCode: 'alp', identifier: data.admissionNo, password: credentials.student.password });
    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe('student');
    expect(res.body.user.mustChangePassword).toBe(true);

    // The same admission number in another school is another student
    expect((await login({ schoolCode: 'BET', identifier: data.admissionNo, password: credentials.student.password })).status).toBe(401);
    // Without a school the number means nothing
    const noSchool = await login({ identifier: data.admissionNo, password: credentials.student.password });
    expect(noSchool.status).toBe(400);
    expect(noSchool.body.message).toMatch(/choose your school/);
  });

  test('unknown IDs and wrong passwords get the same answer', async () => {
    const { data } = await addStudent(A);
    const unknown = await login({ schoolCode: 'ALP', identifier: '99999', password: 'whatever1' });
    const wrong = await login({ schoolCode: 'ALP', identifier: data.admissionNo, password: 'whatever1' });
    const badSchool = await login({ schoolCode: 'NOPE', identifier: data.admissionNo, password: 'whatever1' });
    expect([unknown.status, wrong.status, badSchool.status]).toEqual([401, 401, 401]);
    expect(new Set([unknown.body.message, wrong.body.message, badSchool.body.message]).size).toBe(1);
  });
});

describe('parents sign in with their mobile number', () => {
  test('a parent account is made from the parent mobile; any common format of the number works', async () => {
    const { credentials } = await addStudent(A, { parentName: 'Meera', parentPhone: '+91 98765-43210' });
    expect(credentials.parent).toMatchObject({ schoolCode: 'ALP', loginId: '9876543210', phone: '9876543210', email: null });
    for (const identifier of ['9876543210', '09876543210', '+919876543210', '98765 43210']) {
      const res = await login({ schoolCode: 'ALP', identifier, password: credentials.parent.password });
      expect(res.status).toBe(200);
      expect(res.body.user.role).toBe('parent');
    }
  });

  test('a second child with the same parent mobile is linked to the same parent account', async () => {
    const first = await addStudent(A, { parentPhone: '9876543210' });
    const second = await addStudent(A, { name: 'Dev', parentPhone: '98765 43210' });
    expect(second.linkedExistingParent).toBe(true);
    expect(second.credentials.parent).toBeUndefined();
    const res = await login({ schoolCode: 'ALP', identifier: '9876543210', password: first.credentials.parent.password });
    const kids = await api().get('/api/students/my-child').set(bearer(res.body.token));
    expect(kids.body.children.map((c) => c.name).sort()).toEqual(['Dev', 'Riya']);
  });

  test('admin creates a parent with only a mobile number; duplicate mobiles in a school are refused', async () => {
    const res = await api().post('/api/parents').set(auth(A.admin)).send({ name: 'Sunil', phone: '9123456780', children: [String(A.otherStudent._id)] });
    expect(res.status).toBe(201);
    expect(res.body.credentials).toMatchObject({ schoolCode: 'ALP', loginId: '9123456780', email: null });
    expect((await login({ schoolCode: 'ALP', identifier: '9123456780', password: res.body.credentials.password })).status).toBe(200);
    expect((await api().post('/api/parents').set(auth(A.admin)).send({ name: 'X', phone: '09123456780' })).status).toBe(409);
    expect((await api().post('/api/parents').set(auth(A.admin)).send({ name: 'X', phone: '12345' })).status).toBe(400);
    // Another school can have a parent with the same mobile
    expect((await api().post('/api/parents').set(auth(B.admin)).send({ name: 'Sunil', phone: '9123456780' })).status).toBe(201);
  });
});

describe('staff', () => {
  test('email sign-in works with or without the school code, but not with another school\'s code', async () => {
    expect((await login({ email: A.admin.email, password: 'Password123' })).status).toBe(200);
    expect((await login({ schoolCode: 'ALP', identifier: A.admin.email, password: 'Password123' })).status).toBe(200);
    expect((await login({ schoolCode: 'BET', identifier: A.admin.email, password: 'Password123' })).status).toBe(401);
  });

  test('staff accounts always need an email', async () => {
    await expect(User.create({ name: 'T', role: 'teacher', school: A.school._id, password: 'x' })).rejects.toThrow(/Email is required/);
  });
});

describe('admissions without a student email', () => {
  test('a student is admitted with only a section; login ID is the admission number', async () => {
    const adm = await Admission.create({ school: A.school._id, applicationNo: 'ADM-1', academicYear: '2026-27', classApplied: '5', studentName: 'Ira', parentName: 'P', parentPhone: '9000000021', status: 'Approved' });
    const res = await api().post(`/api/admissions/${adm._id}/admit`).set(auth(A.admin)).send({ section: 'A' });
    expect(res.status).toBe(201);
    expect(res.body.credentials.student.loginId).toBe(res.body.student.admissionNo);
    expect(res.body.credentials.parent.loginId).toBe('9000000021');
  });
});

describe('signing out everywhere', () => {
  test('logout-all ends every session; the next sign-in works', async () => {
    const one = (await login({ email: A.admin.email, password: 'Password123' })).body.token;
    const two = (await login({ email: A.admin.email, password: 'Password123' })).body.token;
    expect((await api().post('/api/users/logout-all').set(bearer(one))).status).toBe(200);
    expect((await api().get('/api/users/profile').set(bearer(one))).status).toBe(401);
    expect((await api().get('/api/users/profile').set(bearer(two))).status).toBe(401);
    const fresh = (await login({ email: A.admin.email, password: 'Password123' })).body.token;
    expect((await api().get('/api/users/profile').set(bearer(fresh))).status).toBe(200);
  });

  test('an admin password reset signs the user out at once', async () => {
    const token = (await login({ email: A.teacherUser.email, password: 'Password123' })).body.token;
    const reset = await api().post(`/api/users/${A.teacherUser._id}/reset-password`).set(auth(A.admin));
    expect(reset.body.credentials.loginId).toBe(A.teacherUser.email);
    expect((await api().get('/api/users/profile').set(bearer(token))).status).toBe(401);
  });

  test('platform tokens are revoked by logout-all of the owner too', async () => {
    const owner = await User.create({ name: 'O', email: 'o@eduamigo.in', role: 'superadmin', password: await hashPassword('OwnerPass123') });
    const token = (await api().post('/api/platform/login').send({ email: owner.email, password: 'OwnerPass123' })).body.token;
    await User.updateOne({ _id: owner._id }, { $inc: { tokenVersion: 1 } });
    expect((await api().get('/api/platform/me').set(bearer(token))).status).toBe(401);
  });
});

describe('forgot password (email code)', () => {
  test('a code is emailed; it resets the password once and signs out old sessions', async () => {
    const old = (await login({ email: A.admin.email, password: 'Password123' })).body.token;
    const req = await api().post('/api/users/forgot-password').send({ email: A.admin.email });
    expect(req.status).toBe(200);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy.mock.calls[0][0].to).toBe(A.admin.email);
    expect(sendSpy.mock.calls[0][0].text).toMatch(/Alpha School/);
    const code = codeFromEmail();
    expect((await PasswordReset.findOne({})).codeHash).not.toContain(code);

    expect((await api().post('/api/users/reset-password').send({ email: A.admin.email, code, newPassword: 'short' })).status).toBe(400);
    const ok = await api().post('/api/users/reset-password').send({ email: A.admin.email, code, newPassword: 'BrandNew789' });
    expect(ok.status).toBe(200);
    expect((await api().get('/api/users/profile').set(bearer(old))).status).toBe(401);
    expect((await login({ email: A.admin.email, password: 'BrandNew789' })).status).toBe(200);
    // The code cannot be used twice
    expect((await api().post('/api/users/reset-password').send({ email: A.admin.email, code, newPassword: 'Another789' })).status).toBe(400);
  });

  test('unknown accounts and accounts without email get the same answer and no email', async () => {
    const { data } = await addStudent(A);
    const unknown = await api().post('/api/users/forgot-password').send({ email: 'nobody@x.com' });
    const student = await api().post('/api/users/forgot-password').send({ schoolCode: 'ALP', identifier: data.admissionNo });
    const real = await api().post('/api/users/forgot-password').send({ email: A.teacherUser.email });
    expect(unknown.body.message).toBe(real.body.message);
    expect(student.body.message).toBe(real.body.message);
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  test('parents with an email can reset using their mobile number as the login ID', async () => {
    await addStudent(A, { parentPhone: '9876543210', parentEmail: 'meera@mail.com' });
    await api().post('/api/users/forgot-password').send({ schoolCode: 'ALP', identifier: '9876543210' });
    expect(sendSpy.mock.calls[0][0].to).toBe('meera@mail.com');
    const res = await api().post('/api/users/reset-password').send({ schoolCode: 'ALP', identifier: '9876543210', code: codeFromEmail(), newPassword: 'Parent12345' });
    expect(res.status).toBe(200);
    expect((await login({ schoolCode: 'ALP', identifier: '9876543210', password: 'Parent12345' })).status).toBe(200);
  });

  test('wrong codes: after 5 tries the code stops working; a new code is not sent again within a minute', async () => {
    await api().post('/api/users/forgot-password').send({ email: A.admin.email });
    const code = codeFromEmail();
    for (let i = 0; i < 5; i += 1) {
      expect((await api().post('/api/users/reset-password').send({ email: A.admin.email, code: '000000', newPassword: 'BrandNew789' })).status).toBe(400);
    }
    expect((await api().post('/api/users/reset-password').send({ email: A.admin.email, code, newPassword: 'BrandNew789' })).status).toBe(400);

    await api().post('/api/users/forgot-password').send({ email: A.admin.email });
    expect(sendSpy).toHaveBeenCalledTimes(2);
    await api().post('/api/users/forgot-password').send({ email: A.admin.email });
    expect(sendSpy).toHaveBeenCalledTimes(2);
  });

  test('no code for suspended schools or deactivated accounts', async () => {
    await User.updateOne({ _id: A.teacherUser._id }, { isActive: false });
    await School.updateOne({ _id: B.school._id }, { isActive: false });
    await api().post('/api/users/forgot-password').send({ email: A.teacherUser.email });
    await api().post('/api/users/forgot-password').send({ email: B.admin.email });
    expect(sendSpy).not.toHaveBeenCalled();
  });
});

describe('resetting a student\'s password', () => {
  test('parent, class teacher and admin can; other teachers, other parents and the student cannot', async () => {
    const parentToken = auth(A.parentUser);
    // Checked first: a reset below signs the student out.
    expect((await api().post(`/api/students/${A.student._id}/reset-password`).set(auth(A.studentUser))).status).toBe(404);
    const res = await api().post(`/api/students/${A.student._id}/reset-password`).set(parentToken);
    expect(res.status).toBe(200);
    expect(res.body.credentials.schoolCode).toBe('ALP');
    expect((await login({ email: A.studentUser.email, password: res.body.credentials.password })).status).toBe(200);

    expect((await api().post(`/api/students/${A.student._id}/reset-password`).set(auth(A.teacherUser))).status).toBe(200);
    expect((await api().post(`/api/students/${A.student._id}/reset-password`).set(auth(A.admin))).status).toBe(200);

    expect((await api().post(`/api/students/${A.otherStudent._id}/reset-password`).set(auth(A.teacherUser))).status).toBe(404); // 10-B, not theirs
    expect((await api().post(`/api/students/${A.otherStudent._id}/reset-password`).set(parentToken)).status).toBe(404);
    expect((await api().post(`/api/students/${A.student._id}/reset-password`).set(auth(B.admin))).status).toBe(404);
  });
});

describe('migration', () => {
  test('existing mobile numbers become usable for sign-in', async () => {
    await User.collection.updateOne({ _id: A.parentUser._id }, { $set: { phone: '+91 90000 00003' }, $unset: { loginPhone: 1 } });
    await Student.updateOne({ _id: A.student._id }, { admissionNo: '77' });
    await migrate({ apply: true, quiet: true });
    expect((await User.findById(A.parentUser._id)).loginPhone).toBe('9000000003');
    expect((await login({ schoolCode: 'ALP', identifier: '9000000003', password: 'Password123' })).status).toBe(200);
    expect((await login({ schoolCode: 'ALP', identifier: '77', password: 'Password123' })).status).toBe(200);
    const again = await migrate({ apply: true, quiet: true });
    expect(again['users.login_phone_set']).toBeUndefined();
  });
});
