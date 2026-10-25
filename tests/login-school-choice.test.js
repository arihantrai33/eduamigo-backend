// Signing in without naming the school. The server works out the account, the school and the role from its own records.
//   - an email is unique across the platform, so it needs no school (unchanged);
//   - a mobile number may belong to accounts in several schools: the password decides which are really the person's.
//     One account signs straight in; several return a short-lived ticket and only the schools the password opened.
//   - an admission number means nothing without a school (unchanged).
process.env.ENABLE_RATE_LIMIT_IN_TESTS = 'false';

const jwt = require('jsonwebtoken');
const { api, connect, disconnect, clear, auth, makeUser, seedSchool } = require('./helpers');
const School = require('../src/models/School');
const User = require('../src/models/User');
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

const login = (body) => api().post('/api/users/login').send(body);
const choose = (body) => api().post('/api/users/login/school').send(body);
const PHONE = '9876543210';
const parentIn = (ctx, over = {}) => makeUser(ctx.school, 'parent', { password: over.password || 'Shared#Pass1', fields: { phone: PHONE, ...over.fields } });

describe('email sign-in is unchanged', () => {
  test('needs no school, and the role and school come from the account', async () => {
    const res = await login({ identifier: A.admin.email, password: 'Password123' });
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ role: 'admin', schoolCode: A.school.code });
    expect(res.body.requiresSchoolChoice).toBeUndefined();
  });

  test('a role sent by the client is ignored', async () => {
    const res = await login({ identifier: A.studentUser.email, password: 'Password123', role: 'admin', schoolCode: A.school.code });
    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe('student');
    // and a token that claims admin is still the student the database says
    const forged = jwt.sign({ id: A.studentUser._id, role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '1h' });
    expect((await api().get('/api/students').set('Authorization', `Bearer ${forged}`)).status).toBe(403);
  });
});

describe('a mobile number without a school', () => {
  test('one account: signs straight in, the school is resolved by the server', async () => {
    await parentIn(A);
    const res = await login({ identifier: '98765 43210', password: 'Shared#Pass1' });
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ role: 'parent', schoolCode: A.school.code });
    expect(res.body.token).toBeTruthy();
  });

  test('wrong password or unknown number: the same plain 401, and no school is named', async () => {
    await parentIn(A);
    await parentIn(B);
    const wrong = await login({ identifier: PHONE, password: 'Wrong#Pass1' });
    const unknown = await login({ identifier: '9123456780', password: 'Wrong#Pass1' });
    expect([wrong.status, unknown.status]).toEqual([401, 401]);
    expect(wrong.body.message).toBe(unknown.body.message);
    expect(JSON.stringify(wrong.body)).not.toMatch(/Alpha|Beta|schools|ticket/);
  });

  test('several accounts open with this password: a ticket and only those schools', async () => {
    await parentIn(A);
    await parentIn(B);
    const res = await login({ identifier: PHONE, password: 'Shared#Pass1' });
    expect(res.status).toBe(200);
    expect(res.body.requiresSchoolChoice).toBe(true);
    expect(res.body.token).toBeUndefined();
    expect(res.body.schools.map((s) => s.code).sort()).toEqual([A.school.code, B.school.code].sort());
    // public profile only: no ids, plan, contacts
    expect(Object.keys(res.body.schools[0]).sort()).toEqual(['accentColor', 'appName', 'city', 'code', 'heroStyle', 'logoUrl', 'name', 'primaryColor', 'tagline']);
  });

  test('a school where the password differs is not offered', async () => {
    await parentIn(A);
    await parentIn(B, { password: 'Other#Pass99' });
    const res = await login({ identifier: PHONE, password: 'Shared#Pass1' });
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ role: 'parent', schoolCode: A.school.code }); // exactly one: signs straight in
  });

  test('a deactivated account or a suspended school is not offered, and not told apart from a wrong password', async () => {
    const pa = await parentIn(A);
    await parentIn(B);
    await User.updateOne({ _id: pa._id }, { isActive: false });
    const one = await login({ identifier: PHONE, password: 'Shared#Pass1' });
    expect(one.body.user?.schoolCode).toBe(B.school.code);
    await School.updateOne({ _id: B.school._id }, { 'subscription.status': 'suspended' });
    const none = await login({ identifier: PHONE, password: 'Shared#Pass1' });
    expect([none.status, none.body.token]).toEqual([403, undefined]);
  });

  test('an admission number without a school still needs the school first', async () => {
    const res = await login({ identifier: '1024', password: 'Shared#Pass1' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/choose your school/i);
  });

  test('naming the school works as before, and does not offer other schools', async () => {
    await parentIn(A);
    await parentIn(B);
    const res = await login({ schoolCode: B.school.code, identifier: PHONE, password: 'Shared#Pass1' });
    expect(res.status).toBe(200);
    expect(res.body.user.schoolCode).toBe(B.school.code);
  });
});

describe('completing the choice', () => {
  const ticketFor = async () => {
    await parentIn(A);
    await parentIn(B);
    return (await login({ identifier: PHONE, password: 'Shared#Pass1' })).body.ticket;
  };

  test('the ticket and a school it lists give a normal session', async () => {
    const ticket = await ticketFor();
    const res = await choose({ ticket, schoolCode: B.school.code.toLowerCase() });
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ role: 'parent', schoolCode: B.school.code });
    const profile = await api().get('/api/users/profile').set('Authorization', `Bearer ${res.body.token}`);
    expect(profile.status).toBe(200);
    expect(profile.body.data.schoolCode).toBe(B.school.code);
  });

  test('a school that is not on the ticket is refused', async () => {
    const ticket = await ticketFor();
    const C = await seedSchool('Gamma School');
    const res = await choose({ ticket, schoolCode: C.school.code });
    expect(res.status).toBe(403);
    expect(res.body.token).toBeUndefined();
  });

  test('a bad, edited, expired or wrong-purpose ticket is refused', async () => {
    const ticket = await ticketFor();
    expect((await choose({ ticket: 'nonsense', schoolCode: A.school.code })).status).toBe(401);
    expect((await choose({ schoolCode: A.school.code })).status).toBe(400);
    const tampered = `${ticket.slice(0, -3)}abc`;
    expect((await choose({ ticket: tampered, schoolCode: A.school.code })).status).toBe(401);
    const decoded = jwt.decode(ticket);
    const expired = jwt.sign({ scope: 'school-choice', ids: decoded.ids }, process.env.JWT_SECRET, { expiresIn: -10 });
    expect((await choose({ ticket: expired, schoolCode: A.school.code })).status).toBe(401);
    // a session token is not a ticket
    const session = jwt.sign({ id: A.admin._id, role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '1h' });
    expect((await choose({ ticket: session, schoolCode: A.school.code })).status).toBe(401);
  });

  test('a ticket is not a session: it opens no protected route', async () => {
    const ticket = await ticketFor();
    for (const path of ['/api/users/profile', '/api/students', '/api/fees/my']) {
      const res = await api().get(path).set('Authorization', `Bearer ${ticket}`);
      expect(res.status).toBe(401);
    }
  });

  test('the account is checked again when the choice is made', async () => {
    const ticket = await ticketFor();
    await User.updateOne({ phone: PHONE, school: B.school._id }, { isActive: false });
    const res = await choose({ ticket, schoolCode: B.school.code });
    expect(res.status).toBe(403);
  });

  test('a password changed after the ticket was given ends the ticket', async () => {
    const ticket = await ticketFor();
    await User.updateMany({ phone: PHONE }, { password: await hashPassword('Brand#New123'), $inc: { tokenVersion: 1 }, passwordChangedAt: new Date(Date.now() + 5000) });
    const res = await choose({ ticket, schoolCode: A.school.code });
    expect(res.status).toBe(401);
    expect(res.body.token).toBeUndefined();
  });
});

describe('who sees what after signing in', () => {
  test('each role gets its own role in the answer, from the database', async () => {
    const cases = [[A.admin, 'admin'], [A.teacherUser, 'teacher'], [A.studentUser, 'student'], [A.parentUser, 'parent']];
    for (const [user, role] of cases) {
      const res = await login({ identifier: user.email, password: 'Password123' });
      expect(res.body.user.role).toBe(role);
    }
  });

  test('a platform account cannot use the school sign-in', async () => {
    await User.create({ name: 'Owner', email: 'owner@eduamigo.test', password: await hashPassword('Owner#Pass123'), role: 'superadmin' });
    const res = await login({ identifier: 'owner@eduamigo.test', password: 'Owner#Pass123' });
    expect(res.status).toBe(401);
    expect(auth).toBeDefined();
  });
});
