const { api, connect, disconnect, clear, auth, seedSchool } = require('./helpers');
const { assertEnv } = require('../src/config/env');

describe('production configuration check', () => {
  const saved = { ...process.env };
  afterEach(() => { process.env = { ...saved }; });

  const base = () => {
    process.env.MONGO_URI = 'mongodb://localhost/x';
    process.env.JWT_SECRET = 'a'.repeat(40);
  };

  test('production refuses to start without CORS_ORIGINS', () => {
    base();
    process.env.NODE_ENV = 'production';
    delete process.env.CORS_ORIGINS;
    expect(() => assertEnv()).toThrow(/CORS_ORIGINS/);
  });

  test('production starts when CORS_ORIGINS is set', () => {
    base();
    process.env.NODE_ENV = 'production';
    process.env.CORS_ORIGINS = 'https://app.example.com';
    expect(() => assertEnv()).not.toThrow();
  });

  test('development and test do not need CORS_ORIGINS', () => {
    base();
    process.env.NODE_ENV = 'development';
    delete process.env.CORS_ORIGINS;
    expect(() => assertEnv()).not.toThrow();
  });
});

describe('request ids and logging', () => {
  let A;
  beforeAll(connect);
  afterAll(disconnect);
  beforeEach(async () => { await clear(); A = await seedSchool('Alpha School'); });

  test('every response carries an X-Request-Id', async () => {
    const res = await api().get('/api/health');
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('a sane id from the proxy is reused, an unsafe one is replaced', async () => {
    const ok = await api().get('/api/health').set('X-Request-Id', 'edge-1234567890');
    expect(ok.headers['x-request-id']).toBe('edge-1234567890');
    const bad = await api().get('/api/health').set('X-Request-Id', 'x y\tz;drop');
    expect(bad.headers['x-request-id']).not.toBe('x y\tz;drop');
  });

  test('the request log has the ids but never the query string or the token', async () => {
    process.env.LOG_IN_TESTS = 'true';
    const lines = [];
    const spy = jest.spyOn(process.stdout, 'write').mockImplementation((chunk) => { lines.push(String(chunk)); return true; });
    try {
      const headers = auth(A.admin);
      await api().get('/api/users/profile?secret=abc123').set(headers);
      await new Promise((r) => setTimeout(r, 20));
    } finally {
      spy.mockRestore();
      delete process.env.LOG_IN_TESTS;
    }
    const entry = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .find((e) => e && e.event === 'request' && e.path.startsWith('/api/users'));
    expect(entry).toBeTruthy();
    expect(entry.requestId).toBeTruthy();
    expect(entry.school).toBe(String(A.school._id));
    expect(entry.path).not.toContain('secret');
    expect(JSON.stringify(entry)).not.toContain(auth(A.admin).Authorization.split(' ')[1]);
  });

  test('a client error stays descriptive and carries no request id in the body', async () => {
    const res = await api().post('/api/users/login').set('Content-Type', 'application/json').send('{bad json');
    expect(res.status).toBe(400);
    expect(res.body.requestId).toBeUndefined();
  });

  test('a server error returns a generic message plus the request id, and logs the cause', async () => {
    const Student = require('../src/models/Student');
    process.env.LOG_IN_TESTS = 'true';
    const err = [];
    const spyErr = jest.spyOn(process.stderr, 'write').mockImplementation((c) => { err.push(String(c)); return true; });
    const spyOut = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const spyFind = jest.spyOn(Student, 'find').mockImplementation(() => { throw new Error('boom-internal-detail'); });
    let res;
    try {
      res = await api().get('/api/students').set(auth(A.admin));
    } finally {
      spyFind.mockRestore(); spyErr.mockRestore(); spyOut.mockRestore();
      delete process.env.LOG_IN_TESTS;
    }
    expect(res.status).toBe(500);
    expect(res.body.message).not.toContain('boom');
    expect(res.body.requestId).toBe(res.headers['x-request-id']);
    const entry = err.map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((e) => e && e.event === 'request_failed');
    expect(entry.requestId).toBe(res.body.requestId);
    expect(entry.message).toContain('boom-internal-detail');
  });
});
