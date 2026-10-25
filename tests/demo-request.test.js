// The public "Request a demo" form: validation, one saved row per email per day, bots, and the rate limit.
process.env.ENABLE_RATE_LIMIT_IN_TESTS = 'true';
process.env.RATE_LIMIT_STORE = 'memory';
process.env.API_ANON_PER_MINUTE = '1000';
process.env.DEMO_REQUESTS_PER_HOUR = '1000';

const { api, connect, disconnect, clear } = require('./helpers');
const DemoRequest = require('../src/models/DemoRequest');

beforeAll(connect);
afterAll(disconnect);
beforeEach(clear);

const valid = (over = {}) => ({
  name: 'Asha Verma', schoolName: 'Green Valley Public School', role: 'Principal',
  email: 'Asha@GreenValley.example', phone: '+91 98765 43210', city: 'Noida', students: '300-1000',
  message: 'We would like to see the fee and attendance modules.', ...over,
});

describe('POST /api/public/demo-requests', () => {
  test('saves a valid request without a login, with the email lower-cased', async () => {
    const res = await api().post('/api/public/demo-requests').send(valid());
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    const saved = await DemoRequest.find();
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ email: 'asha@greenvalley.example', schoolName: 'Green Valley Public School', status: 'new' });
  });

  test('phone, city, role, students and message are optional', async () => {
    const res = await api().post('/api/public/demo-requests').send({ name: 'Ravi', schoolName: 'Sunrise School', email: 'ravi@sunrise.example' });
    expect(res.status).toBe(201);
    expect(await DemoRequest.countDocuments()).toBe(1);
  });

  test.each([
    ['name', { name: '' }],
    ['schoolName', { schoolName: ' ' }],
    ['email', { email: 'not-an-email' }],
    ['email', { email: 'a@b' }],
    ['phone', { phone: 'call me' }],
    ['students', { students: 'a lot' }],
    ['message', { message: 'x'.repeat(1001) }],
    ['name', { name: { $gt: '' } }],
  ])('rejects a bad %s and names the field', async (field, over) => {
    const res = await api().post('/api/public/demo-requests').send(valid(over));
    expect(res.status).toBe(400);
    expect(res.body.fieldErrors[field]).toBeTruthy();
    expect(await DemoRequest.countDocuments()).toBe(0);
  });

  test('the same email twice in a day is saved once, and both calls succeed', async () => {
    const first = await api().post('/api/public/demo-requests').send(valid());
    const again = await api().post('/api/public/demo-requests').send(valid({ name: 'Someone Else' }));
    expect([first.status, again.status]).toEqual([201, 201]);
    expect(await DemoRequest.countDocuments()).toBe(1);
  });

  test('parallel submissions of one email are saved once', async () => {
    const results = await Promise.all([1, 2, 3].map(() => api().post('/api/public/demo-requests').send(valid())));
    expect(results.map((r) => r.status)).toEqual([201, 201, 201]);
    expect(await DemoRequest.countDocuments()).toBe(1);
  });

  test('a filled hidden field (a bot) gets the normal answer and nothing is saved', async () => {
    const res = await api().post('/api/public/demo-requests').send(valid({ website: 'http://spam.example' }));
    expect(res.status).toBe(201);
    expect(await DemoRequest.countDocuments()).toBe(0);
  });

  test('ignores fields it does not know (no way to set the status or id)', async () => {
    await api().post('/api/public/demo-requests').send(valid({ status: 'closed', _id: '64b000000000000000000000', dedupeKey: 'x' }));
    const [saved] = await DemoRequest.find();
    expect(saved.status).toBe('new');
    expect(String(saved._id)).not.toBe('64b000000000000000000000');
    expect(saved.dedupeKey).not.toBe('x');
  });

  test('is limited per address, and one address does not use up another one\'s allowance', async () => {
    process.env.DEMO_REQUESTS_PER_HOUR = '3'; // read on every request; the other tests run with 1000
    try {
      const send = (ip, i) => api().post('/api/public/demo-requests').set('X-Forwarded-For', ip).send(valid({ email: `p${i}@school.example` }));
      const statuses = [];
      for (let i = 0; i < 5; i++) statuses.push((await send('203.0.113.7', i)).status);
      expect(statuses).toEqual([201, 201, 201, 429, 429]);
      expect((await send('203.0.113.8', 9)).status).toBe(201);
    } finally {
      process.env.DEMO_REQUESTS_PER_HOUR = '1000';
    }
  });

  test('cannot be read back through the public API', async () => {
    await api().post('/api/public/demo-requests').send(valid());
    const res = await api().get('/api/public/demo-requests');
    expect(res.status).toBe(404);
  });
});
