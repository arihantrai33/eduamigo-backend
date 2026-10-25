// Passwords: the native bcrypt in services/passwordHash.js must accept every hash the old pure-JavaScript bcryptjs wrote (and the reverse),
// so switching libraries never locks anyone out and no password is rehashed or reset.
const bcryptjs = require('bcryptjs');
const passwordHash = require('../src/services/passwordHash');
const { hashPassword } = require('../src/services/credentials');

// Written by bcryptjs 3.0.3 (the library used before the switch) at cost 10 and 12, as stored in real accounts.
const OLD_COST_10 = '$2b$10$DSxx9i7nJyoDyQ0.tbQCb.r/iq.rQCBw7OwWOCV9enpf3rVbpT0lC';
const OLD_COST_12 = '$2b$12$HXXqKR4Fn23e3oR.yre3aebM1vp1dZ/Tp1wESniGy8cm9zhBTYGqq';

describe('password hashing', () => {
  test('uses the native bcrypt in this environment', () => {
    expect(passwordHash.implementation).toBe('bcrypt');
  });

  test('accepts hashes written by bcryptjs, at cost 10 and 12, and refuses a wrong password', async () => {
    expect(await passwordHash.compare('Demo@1234', OLD_COST_10)).toBe(true);
    expect(await passwordHash.compare('Kite-4829-Moon', OLD_COST_12)).toBe(true);
    expect(await passwordHash.compare('demo@1234', OLD_COST_10)).toBe(false);
    expect(await passwordHash.compare('Demo@1234', OLD_COST_12)).toBe(false);
    expect(OLD_COST_10.startsWith('$2b$10$')).toBe(true);
  });

  test('a new hash is standard bcrypt at the configured cost and bcryptjs can still check it', async () => {
    const hashed = await hashPassword('Winter-2026-ok');
    expect(hashed).toMatch(/^\$2[ab]\$04\$/); // tests run at cost 4 (BCRYPT_ROUNDS); production uses 10
    expect(await bcryptjs.compare('Winter-2026-ok', hashed)).toBe(true);
    expect(await bcryptjs.compare('Winter-2026-no', hashed)).toBe(false);
    expect(await passwordHash.compare('Winter-2026-ok', hashed)).toBe(true);
  });

  test('the cost of production hashes is not lowered: without BCRYPT_ROUNDS the cost is 10', () => {
    const saved = process.env.BCRYPT_ROUNDS;
    delete process.env.BCRYPT_ROUNDS;
    let cost;
    jest.isolateModules(() => {
      const { hashPassword: fresh } = require('../src/services/credentials');
      cost = fresh('Another-Pass-1');
    });
    process.env.BCRYPT_ROUNDS = saved;
    return cost.then((h) => expect(h.startsWith('$2b$10$')).toBe(true));
  });

  test('while a password is being checked, other work keeps running', async () => {
    let ticks = 0;
    const timer = setInterval(() => { ticks += 1; }, 10);
    await Promise.all(Array.from({ length: 3 }, () => passwordHash.compare('Kite-4829-Moon', OLD_COST_12))); // about 3 x 200 ms of hashing
    clearInterval(timer);
    // The request thread stayed free: about 20 ticks. A check that blocks the thread (bcryptjs) lets only one or two through.
    expect(ticks).toBeGreaterThanOrEqual(8);
  });

  test('if the native module cannot be loaded, bcryptjs is used and sign-in still works', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    let fallback;
    jest.isolateModules(() => {
      jest.doMock('bcrypt', () => { throw Object.assign(new Error('no binary'), { code: 'MODULE_NOT_FOUND' }); });
      fallback = require('../src/services/passwordHash');
    });
    expect(fallback.implementation).toBe('bcryptjs');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Native bcrypt could not be loaded'));
    expect(await fallback.compare('Demo@1234', OLD_COST_10)).toBe(true);
    expect(await fallback.compare('nope', OLD_COST_10)).toBe(false);
    warn.mockRestore();
    jest.dontMock('bcrypt');
  });
});

describe('sign-in checks are limited so a flood cannot starve the worker threads or build an endless queue', () => {
  const load = (env) => {
    let mod;
    const saved = { ...process.env };
    Object.assign(process.env, env);
    jest.isolateModules(() => { mod = require('../src/services/passwordHash'); });
    process.env = saved;
    return mod;
  };

  test('at most threads - 1 checks run at once (3 by default), the rest wait, and all of them finish with the right answers', async () => {
    const mod = load({});
    expect(mod.stats().maxRunning).toBe(3);
    const hashed = await mod.hash('Open-Sesame-9', 4);
    let peak = 0;
    const watch = setInterval(() => { peak = Math.max(peak, mod.stats().running); }, 1);
    const answers = await Promise.all(Array.from({ length: 40 }, (_, i) => mod.compare(i % 2 ? 'Open-Sesame-9' : 'wrong-one-1', hashed)));
    clearInterval(watch);
    expect(answers).toEqual(Array.from({ length: 40 }, (_, i) => i % 2 === 1));
    expect(peak).toBeLessThanOrEqual(3);
    expect(mod.stats()).toMatchObject({ running: 0, waiting: 0 });
  });

  test('when too many are already waiting the sign-in is refused with a plain 503, and the line recovers afterwards', async () => {
    const mod = load({ PASSWORD_CHECK_CONCURRENCY: '1', PASSWORD_CHECK_QUEUE: '2' });
    const hashed = await mod.hash('Open-Sesame-9', 8);
    const attempts = Array.from({ length: 6 }, () => mod.compare('Open-Sesame-9', hashed).then((ok) => ({ ok }), (err) => ({ err })));
    const settled = await Promise.all(attempts);
    const refused = settled.filter((r) => r.err);
    expect(settled.filter((r) => r.ok === true)).toHaveLength(3); // 1 running + 2 waiting
    expect(refused).toHaveLength(3);
    expect(refused[0].err.status).toBe(503);
    expect(refused[0].err.expose).toBe(true);
    expect(refused[0].err.extra).toEqual({ code: 'SIGN_IN_BUSY' });
    expect(mod.stats()).toMatchObject({ running: 0, waiting: 0 });
    expect(await mod.compare('Open-Sesame-9', hashed)).toBe(true); // works again
  });

  test('a check that fails (bad hash) gives its place back', async () => {
    const mod = load({ PASSWORD_CHECK_CONCURRENCY: '1', PASSWORD_CHECK_QUEUE: '5' });
    await expect(mod.compare('x', undefined)).rejects.toBeTruthy();
    expect(mod.stats()).toMatchObject({ running: 0, waiting: 0 });
    const hashed = await mod.hash('Open-Sesame-9', 4);
    expect(await mod.compare('Open-Sesame-9', hashed)).toBe(true);
  });
});
