// Adding a demo school named for a prospect: it only adds, it refuses production-like databases and duplicate codes.
const { spawn } = require('child_process');
const path = require('path');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const passwordHash = require('../src/services/passwordHash');
const { parse, fakePhones } = require('../src/scripts/addProspectDemo');

const ADD = path.join(__dirname, '../src/scripts/addProspectDemo.js');
const RESET = path.join(__dirname, '../src/scripts/resetDemo.js');
const PW = 'a-long-demo-password-1';
let server;

const run = (script, uri, args = [], extra = {}) => new Promise((resolve) => {
  const child = spawn('node', [script, ...args], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, MONGO_URI: uri, DEMO_PASSWORD: PW, DEMO_RESET_OK: 'yes', SEED_DEMO_OK: 'yes', BCRYPT_ROUNDS: '4', NODE_ENV: 'test', DISABLE_JOBS: 'true', ...extra },
  });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  const timer = setTimeout(() => child.kill(), 90000);
  child.on('exit', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
});
async function inspect(uri, fn) { const c = await mongoose.createConnection(uri).asPromise(); try { return await fn(c.db); } finally { await c.close(); } }

beforeAll(async () => { server = await MongoMemoryServer.create(); }, 120000);
afterAll(async () => { await server.stop(); });

const base = { MONGO_URI: 'mongodb+srv://u:p@x.mongodb.net/eduamigo_staging', DEMO_PASSWORD: PW, SEED_DEMO_OK: 'yes' };
const args = ['--name', 'Example Public School', '--code', 'exps', '--city', 'Patna'];

describe('arguments and guards', () => {
  test('accepts a staging or demo database and normalises the code', () => {
    expect(parse(args, base).code).toBe('EXPS');
    expect(parse(args, { ...base, MONGO_URI: 'mongodb+srv://u:p@x.mongodb.net/eduamigo_demo' }).dbName).toBe('eduamigo_demo');
  });
  test.each(['eduamigo', 'production', 'eduamigo_prod'])('refuses the database "%s"', (name) => {
    expect(() => parse(args, { ...base, MONGO_URI: `mongodb+srv://u:p@x.mongodb.net/${name}` })).toThrow(/must end in _staging or _demo/);
  });
  test('needs confirmation, a real password, a valid code, https logo and hex colours', () => {
    expect(() => parse(args, { ...base, SEED_DEMO_OK: '' })).toThrow(/SEED_DEMO_OK/);
    expect(() => parse(args, { ...base, DEMO_PASSWORD: 'short' })).toThrow(/12 characters/);
    expect(() => parse(['--name', 'Example Public School', '--code', 'a b'], base)).toThrow(/--code/);
    expect(() => parse([...args, '--logo-url', 'http://x.example/logo.png'], base)).toThrow(/https/);
    expect(() => parse([...args, '--color', 'teal'], base)).toThrow(/Colours/);
  });
  test('invented parent phone numbers are ten digits and differ between schools', () => {
    const a = fakePhones('EXPS'); const b = fakePhones('OTHER1');
    expect(a.every((p) => /^\d{10}$/.test(p))).toBe(true);
    expect(a[0]).not.toBe(b[0]);
  });
});

describe('against a database', () => {
  test('adds exactly one school next to the existing demo schools, and changes nothing else', async () => {
    const uri = server.getUri('keep_demo');
    expect((await run(RESET, uri)).status).toBe(0);
    const snapshot = await inspect(uri, async (db) => ({
      schools: await db.collection('schools').countDocuments({}), users: await db.collection('users').countDocuments({}),
      students: await db.collection('students').countDocuments({}), gvpsAdmin: (await db.collection('users').findOne({ email: 'admin@gvps.demo' })).password,
    }));

    const r = await run(ADD, uri, [...args, '--color', '#1D4ED8']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Added "Example Public School" \(code EXPS\)/);
    expect(r.stdout).not.toContain(PW);

    await inspect(uri, async (db) => {
      expect(await db.collection('schools').countDocuments({})).toBe(snapshot.schools + 1);
      expect(await db.collection('students').countDocuments({})).toBe(snapshot.students + 3);
      const old = await db.collection('users').findOne({ email: 'admin@gvps.demo' });
      expect(old.password).toBe(snapshot.gvpsAdmin); // existing accounts untouched
      const school = await db.collection('schools').findOne({ code: 'EXPS' });
      expect(school.name).toBe('Example Public School');
      expect(school.branding.primaryColor).toBe('#1D4ED8');
      expect(school.branding.logoUrl).toBe('');
      expect(school.branding.tagline).toBe('Demo with sample data');
      const admin = await db.collection('users').findOne({ email: 'admin@exps.demo' });
      expect(await passwordHash.compare(PW, admin.password)).toBe(true);
      expect(await db.collection('users').findOne({ email: 'owner@eduamigo.demo', school: school._id })).toBeNull();
      // tenant separation: the new school's users carry its own school id only
      const strays = await db.collection('users').countDocuments({ email: /@exps\.demo$/, school: { $ne: school._id } });
      expect(strays).toBe(0);
    });
  }, 180000);

  test('refuses a code that already exists and leaves everything as it was', async () => {
    const uri = server.getUri('dup_demo');
    expect((await run(RESET, uri)).status).toBe(0);
    const r = await run(ADD, uri, ['--name', 'Another Name', '--code', 'gvps']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/already exists/);
    await inspect(uri, async (db) => expect((await db.collection('schools').findOne({ code: 'GVPS' })).name).toBe('Green Valley Public School'));
  }, 180000);

  test('refuses a production-style database name and adds nothing', async () => {
    const uri = server.getUri('eduamigo');
    const r = await run(ADD, uri, args);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/must end in _staging or _demo/);
    await inspect(uri, async (db) => expect(await db.collection('schools').countDocuments({})).toBe(0));
  }, 60000);
});
