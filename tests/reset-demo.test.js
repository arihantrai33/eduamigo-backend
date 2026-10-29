// The hosted demo reset: it must work on a demo database and refuse to touch anything else.
const { spawn } = require('child_process');
const path = require('path');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const passwordHash = require('../src/services/passwordHash');
const { checkSettings, dbNameOf, DEMO_CODES } = require('../src/scripts/resetDemo');

const SCRIPT = path.join(__dirname, '../src/scripts/resetDemo.js');
const PW = 'a-long-demo-password-1';
let server;

// Asynchronous on purpose: the in-memory MongoDB is a child process of this one, and a blocked event loop would stop its output from being read.
const run = (uri, extra = {}) => new Promise((resolve) => {
  // A clean environment: only what the script needs (nothing leaks in from the test runner's own settings).
  const child = spawn('node', [SCRIPT], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, MONGO_URI: uri, DEMO_PASSWORD: PW, DEMO_RESET_OK: 'yes', BCRYPT_ROUNDS: '4', NODE_ENV: 'test', DISABLE_JOBS: 'true', ...extra },
  });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  const timer = setTimeout(() => child.kill(), 90000);
  child.on('exit', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
});

async function inspect(uri, fn) {
  const c = await mongoose.createConnection(uri).asPromise();
  try { return await fn(c.db); } finally { await c.close(); }
}

beforeAll(async () => { server = await MongoMemoryServer.create(); }, 120000);
afterAll(async () => { await server.stop(); });

describe('reset guards (no database involved)', () => {
  const ok = { DEMO_RESET_OK: 'yes', DEMO_PASSWORD: PW };
  test('reads the database name from the connection string', () => {
    expect(dbNameOf('mongodb+srv://u:p@x.mongodb.net/eduamigo_demo?appName=A')).toBe('eduamigo_demo');
  });
  test('a demo database is allowed', () => {
    expect(() => checkSettings({ ...ok, MONGO_URI: 'mongodb+srv://u:p@demo.mongodb.net/eduamigo_demo' })).not.toThrow();
  });
  test.each(['eduamigo', 'eduamigo_staging', 'eduamigo_demo_old', 'demo'])('refuses the database "%s"', (name) => {
    expect(() => checkSettings({ ...ok, MONGO_URI: `mongodb+srv://u:p@demo.mongodb.net/${name}` })).toThrow(/must end in _demo/);
  });
  test('refuses the production cluster even if the database is called _demo', () => {
    expect(() => checkSettings({ ...ok, MONGO_URI: 'mongodb+srv://u:p@cluster0.rmyiph4.mongodb.net/eduamigo_demo' })).toThrow(/protected cluster/);
  });
  test('needs the explicit confirmation and a real password', () => {
    const uri = 'mongodb+srv://u:p@demo.mongodb.net/eduamigo_demo';
    expect(() => checkSettings({ MONGO_URI: uri, DEMO_PASSWORD: PW })).toThrow(/DEMO_RESET_OK/);
    expect(() => checkSettings({ MONGO_URI: uri, DEMO_RESET_OK: 'yes', DEMO_PASSWORD: 'short' })).toThrow(/12 characters/);
  });
});

describe('reset against a database', () => {
  test('fills an empty demo database with the fictional schools, and a second run wipes what testers added', async () => {
    const uri = server.getUri('fresh_demo');
    const first = await run(uri);
    expect(first.status).toBe(0);
    expect(first.stdout).toMatch(/Seeded \d+ fictional demo accounts/);
    expect(first.stdout).not.toContain(PW);

    await inspect(uri, async (db) => {
      const schools = await db.collection('schools').find({}).toArray();
      expect(schools.map((s) => s.code).sort()).toEqual([...DEMO_CODES].sort());
      expect(JSON.stringify(schools)).not.toMatch(/allied|alliedinternational/i);
      const admin = await db.collection('users').findOne({ email: 'admin@gvps.demo' });
      expect(await passwordHash.compare(PW, admin.password)).toBe(true);
      const owner = await db.collection('users').findOne({ email: 'owner@eduamigo.demo' });
      expect(await passwordHash.compare(PW, owner.password)).toBe(false); // no owner login with the demo password
      await db.collection('messages').insertOne({ text: 'a tester wrote this' });
    });

    const second = await run(uri);
    expect(second.status).toBe(0);
    await inspect(uri, async (db) => {
      expect(await db.collection('messages').countDocuments({ text: 'a tester wrote this' })).toBe(0);
      expect(await db.collection('schools').countDocuments({})).toBe(DEMO_CODES.length);
    });
  }, 180000);

  test('refuses (and deletes nothing) when the database holds a school that is not a demo school', async () => {
    const uri = server.getUri('mixed_demo');
    await inspect(uri, (db) => db.collection('schools').insertOne({ code: 'REALSCHOOL', name: 'A real school' }));
    const r = await run(uri);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/not demo schools \(REALSCHOOL\)/);
    await inspect(uri, async (db) => expect(await db.collection('schools').countDocuments({ code: 'REALSCHOOL' })).toBe(1));
  }, 60000);

  test('refuses a database that is not named _demo, and deletes nothing', async () => {
    const uri = server.getUri('eduamigo_staging');
    await inspect(uri, (db) => db.collection('schools').insertOne({ code: 'GVPS', name: 'staging school' }));
    const r = await run(uri);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/must end in _demo/);
    await inspect(uri, async (db) => expect(await db.collection('schools').countDocuments({})).toBe(1));
  }, 60000);
});
