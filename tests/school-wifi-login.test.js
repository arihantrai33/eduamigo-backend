// A whole school signs in from ONE public address (the school's wifi). With the production limits, a morning rush of hundreds of sign-ins
// in a minute (each preceded by the school lookup the sign-in page makes) must all go through, while the per-account brute-force
// protection stays in place.
process.env.ENABLE_RATE_LIMIT_IN_TESTS = 'true';
process.env.RATE_LIMIT_STORE = 'memory';
delete process.env.API_ANON_PER_MINUTE; delete process.env.PUBLIC_LOOKUP_PER_MINUTE; // the production defaults

const { api, connect, disconnect, clear, seedSchool } = require('./helpers');
const User = require('../src/models/User');
const School = require('../src/models/School');
const { hashPassword } = require('../src/services/credentials');

let A;
beforeAll(connect);
afterAll(disconnect);
beforeEach(async () => { await clear(); A = await seedSchool('Alpha School'); await School.updateOne({ _id: A.school._id }, { code: 'ALP' }); });

test('400 different people sign in from one address within a minute, each after the school lookup, and none is turned away', async () => {
  const password = 'Morning-Rush-9';
  const hash = await hashPassword(password);
  await User.insertMany(Array.from({ length: 400 }, (_, i) => ({ name: `Teacher ${i}`, email: `rush${i}@alpha.test`, role: 'teacher', school: A.school._id, password: hash, mustChangePassword: false })));
  const refused = [];
  for (let i = 0; i < 400; i += 1) {
    const lookup = await api().get('/api/public/schools/ALP');
    const login = await api().post('/api/users/login').send({ schoolCode: 'ALP', identifier: `rush${i}@alpha.test`, password });
    if (lookup.status !== 200 || login.status !== 200) refused.push(`#${i}: lookup ${lookup.status}, sign-in ${login.status}`);
  }
  expect(refused).toEqual([]);
}, 120000);

test('guessing one account\'s password is still stopped (10 tries), even though the address allowance is large', async () => {
  const statuses = [];
  for (let i = 0; i < 14; i += 1) statuses.push((await api().post('/api/users/login').send({ schoolCode: 'ALP', identifier: A.admin.email, password: `wrong-guess-${i}` })).status);
  expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
  expect(statuses.slice(10).every((s) => s === 429)).toBe(true);
});
