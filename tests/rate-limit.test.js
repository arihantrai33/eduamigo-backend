// Set before anything loads the limiters: they read these once, at startup.
process.env.ENABLE_RATE_LIMIT_IN_TESTS = 'true';
process.env.RATE_LIMIT_STORE = 'mongo';
process.env.API_ANON_PER_MINUTE = '1000';
process.env.API_USER_PER_MINUTE = '1000';

const { api, connect, disconnect, clear, auth, seedSchool } = require('./helpers');
const RateLimit = require('../src/models/RateLimit');
const { MongoRateLimitStore } = require('../src/services/rateLimitStore');

let A;

beforeAll(connect);
afterAll(disconnect);
beforeEach(async () => {
  await clear();
  A = await seedSchool('Alpha School');
});

const store = (prefix = 't', windowMs = 60000) => {
  const s = new MongoRateLimitStore({ prefix });
  s.init({ windowMs });
  return s;
};

describe('MongoDB rate-limit store', () => {
  test('counts hits and keeps one reset time for the window', async () => {
    const s = store();
    const a = await s.increment('k');
    const b = await s.increment('k');
    const c = await s.increment('k');
    expect([a.totalHits, b.totalHits, c.totalHits]).toEqual([1, 2, 3]);
    expect(+c.resetTime).toBe(+a.resetTime);
  });

  test('starts a new window once the old one has ended', async () => {
    const s = store('short', 120);
    await s.increment('k');
    expect((await s.increment('k')).totalHits).toBe(2);
    await new Promise((r) => setTimeout(r, 180));
    expect((await s.increment('k')).totalHits).toBe(1);
  });

  test('two server instances share the same count, different limiters and keys do not', async () => {
    const one = store('login');
    const two = store('login'); // as if a second server process
    await one.increment('ip:1');
    expect((await two.increment('ip:1')).totalHits).toBe(2);
    expect((await two.increment('ip:2')).totalHits).toBe(1);
    expect((await store('reset').increment('ip:1')).totalHits).toBe(1);
  });

  test('parallel requests are counted exactly once each', async () => {
    const s = store();
    const hits = (await Promise.all(Array.from({ length: 25 }, () => s.increment('burst')))).map((r) => r.totalHits);
    expect([...hits].sort((a, b) => a - b)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
  });

  test('decrement and resetKey work, and never go below zero', async () => {
    const s = store();
    await s.increment('k'); await s.increment('k');
    await s.decrement('k');
    expect((await s.increment('k')).totalHits).toBe(2);
    await s.resetKey('k');
    expect((await s.increment('k')).totalHits).toBe(1);
    await s.decrement('missing');
  });

  test('rows expire through a TTL index', async () => {
    await RateLimit.init();
    const indexes = await RateLimit.collection.indexes();
    expect(indexes.some((i) => i.key.resetAt === 1 && i.expireAfterSeconds === 0)).toBe(true);
  });
});

describe('login limits', () => {
  const login = (ip, body) => api().post('/api/users/login').set('X-Forwarded-For', ip).send(body);
  const wrong = () => ({ schoolCode: 'NOPE', identifier: 'someone@example.com', password: 'bad-password' });

  test('the 11th attempt from one address for one account is refused, and the count is stored in MongoDB', async () => {
    let last;
    for (let i = 0; i < 11; i += 1) last = await login('10.0.0.1', wrong());
    expect(last.status).toBe(429);
    expect(last.body.message).toMatch(/Too many login attempts/);
    expect(await RateLimit.countDocuments({ _id: /^login:/ })).toBeGreaterThan(0);
  });

  test('many addresses guessing one account are stopped by the per-account limit', async () => {
    let refused = 0;
    for (let i = 0; i < 32; i += 1) {
      const res = await login(`10.1.${Math.floor(i / 200)}.${i + 1}`, wrong());
      if (res.status === 429) refused += 1;
    }
    expect(refused).toBeGreaterThanOrEqual(2); // attempts 31 and 32
    // A different account is not affected.
    const other = await login('10.9.9.9', { ...wrong(), identifier: 'other@example.com' });
    expect(other.status).not.toBe(429);
  });
});

describe('API flood guard', () => {
  const saved = { a: process.env.API_ANON_PER_MINUTE, u: process.env.API_USER_PER_MINUTE };
  beforeAll(() => { process.env.API_ANON_PER_MINUTE = '6'; process.env.API_USER_PER_MINUTE = '9'; });
  afterAll(() => { process.env.API_ANON_PER_MINUTE = saved.a; process.env.API_USER_PER_MINUTE = saved.u; });

  test('anonymous callers get a small allowance per address, and /api/health is never counted', async () => {
    const hit = () => api().get('/api/nothing-here').set('X-Forwarded-For', '10.2.0.1');
    const codes = [];
    for (let i = 0; i < 8; i += 1) codes.push((await hit()).status);
    expect(codes.slice(0, 6)).toEqual(Array(6).fill(404));
    expect(codes.slice(6)).toEqual([429, 429]);
    for (let i = 0; i < 10; i += 1) expect((await api().get('/api/health').set('X-Forwarded-For', '10.2.0.1')).status).toBe(200);
  });

  test('signed-in users are counted per session, not per address', async () => {
    const asAdmin = () => api().get('/api/users/profile').set(auth(A.admin)).set('X-Forwarded-For', '10.3.0.1');
    const asParent = () => api().get('/api/users/profile').set(auth(A.parentUser)).set('X-Forwarded-For', '10.3.0.1');
    for (let i = 0; i < 9; i += 1) expect((await asAdmin()).status).toBe(200);
    expect((await asAdmin()).status).toBe(429);
    expect((await asParent()).status).toBe(200); // same address, another user
  });
});

describe('when MongoDB cannot be reached by the limiter', () => {
  test('requests are let through instead of locking everyone out', async () => {
    const spy = jest.spyOn(RateLimit, 'findOneAndUpdate').mockImplementation(() => { throw new Error('store down'); });
    const quiet = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await api().post('/api/users/login').set('X-Forwarded-For', '10.7.7.7')
        .send({ schoolCode: 'NOPE', identifier: 'a@b.com', password: 'x' });
      expect(res.status).not.toBe(429);
      expect(res.status).toBeLessThan(500);
    } finally { spy.mockRestore(); quiet.mockRestore(); }
  });
});
