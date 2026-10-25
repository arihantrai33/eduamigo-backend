// When a flood of sign-ins has filled the waiting line (services/passwordHash.js), the extra sign-ins are told plainly that sign-in is busy (503).
// A busy answer must never look like "wrong password", and the line must recover.
process.env.PASSWORD_CHECK_CONCURRENCY = '1';
process.env.PASSWORD_CHECK_QUEUE = '1';
jest.mock('bcrypt', () => {
  const real = jest.requireActual('bcrypt');
  return { ...real, compare: (plain, hashed) => new Promise((resolve, reject) => setTimeout(() => real.compare(plain, hashed).then(resolve, reject), 150)) };
});

const { api, connect, disconnect, clear, seedSchool } = require('./helpers');
const School = require('../src/models/School');

let A;
beforeAll(connect);
afterAll(disconnect);
beforeEach(async () => {
  await clear();
  A = await seedSchool('Alpha School');
  await School.updateOne({ _id: A.school._id }, { code: 'ALP' });
});

const signIn = (password) => api().post('/api/users/login').send({ schoolCode: 'ALP', identifier: A.admin.email, password });

test('extra sign-ins during a flood get a plain "busy" 503 (not "wrong password"), the others are answered correctly, and it recovers', async () => {
  const alone = (await signIn('wrong-password-1')).status; // one alone, to learn what a wrong password looks like
  expect(alone).toBe(401);
  const answers = await Promise.all(Array.from({ length: 6 }, () => signIn('wrong-password-1')));
  const statuses = answers.map((r) => r.status).sort();
  expect(statuses.filter((s) => s === 401).length).toBeGreaterThanOrEqual(2); // 1 running + 1 waiting are checked normally
  const busy = answers.filter((r) => r.status === 503);
  expect(busy.length).toBeGreaterThanOrEqual(1);
  expect(busy[0].body.message).toBe('Sign-in is very busy right now. Please try again in a few seconds.');
  expect(busy[0].body.code).toBe('SIGN_IN_BUSY');
  expect(statuses.every((s) => s === 401 || s === 503)).toBe(true); // nothing was let in, nothing else went wrong
  const again = await signIn('wrong-password-1');
  expect(again.status).toBe(401); // the line has recovered
});
