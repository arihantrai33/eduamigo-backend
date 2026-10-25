// Owner-console integrations: SMTP email and phone OTP.
// Test kinds, kept apart on purpose:
//   LOCAL SMTP SINK  - a small SMTP server inside this test file: proves the real SMTP conversation, login and message hand-off. It is
//                      not a real mail provider and says nothing about inbox delivery.
//   MOCKED PROVIDER  - axios is replaced for the two SMS providers: proves our request shape and error handling, not the provider.
//   REAL DELIVERY    - not tested here (no credentials). See docs/INTEGRATIONS.md.
const net = require('net');
process.env.ALLOW_PRIVATE_SMTP_HOSTS = 'true'; // lets the tests talk to the local sink; one test turns it off again
jest.mock('axios');
const axios = require('axios');
const { api, connect, disconnect, clear, auth, seedSchool } = require('./helpers');
const User = require('../src/models/User');
const PlatformSetting = require('../src/models/PlatformSetting');
const IntegrationLog = require('../src/models/IntegrationLog');
const AuditLog = require('../src/models/AuditLog');
const PhoneOtp = require('../src/models/PhoneOtp');
const { hashPassword } = require('../src/services/credentials');

// A minimal SMTP server: EHLO, AUTH PLAIN/LOGIN, MAIL, RCPT, DATA, QUIT. Records what it receives.
function smtpSink({ user = 'mailer', pass = 'p@ss-secret-123' } = {}) {
  const received = [];
  const server = net.createServer((sock) => {
    let buf = ''; let data = null; let mail = { from: '', to: [], body: '' }; let loginStep = 0;
    const send = (l) => sock.write(`${l}\r\n`);
    send('220 sink ESMTP');
    sock.on('data', (chunk) => {
      buf += chunk.toString();
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (data !== null) { if (line === '.') { mail.body = data; received.push(mail); mail = { from: '', to: [], body: '' }; data = null; send('250 queued'); } else data += `${line}\n`; continue; }
        if (loginStep === 1) { loginStep = 2; send('334 UGFzc3dvcmQ6'); mail.user = Buffer.from(line, 'base64').toString(); continue; }
        if (loginStep === 2) { loginStep = 0; Buffer.from(line, 'base64').toString() === pass && mail.user === user ? send('235 ok') : send('535 5.7.8 bad credentials'); continue; }
        const u = line.toUpperCase();
        if (u.startsWith('EHLO') || u.startsWith('HELO')) { sock.write('250-sink\r\n250 AUTH PLAIN LOGIN\r\n'); }
        else if (u.startsWith('AUTH PLAIN')) { const [, u2, p2] = Buffer.from(line.split(' ')[2] || '', 'base64').toString().split('\0'); u2 === user && p2 === pass ? send('235 ok') : send('535 5.7.8 bad credentials'); }
        else if (u === 'AUTH LOGIN') { loginStep = 1; send('334 VXNlcm5hbWU6'); }
        else if (u.startsWith('MAIL FROM')) { mail.from = line; send('250 ok'); }
        else if (u.startsWith('RCPT TO')) { mail.to.push(line); send('250 ok'); }
        else if (u === 'DATA') { data = ''; send('354 go'); }
        else if (u === 'QUIT') { send('221 bye'); sock.end(); }
        else send('250 ok');
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, received })));
}

let owner; let token; let A; let sink;
const ownerH = () => ({ Authorization: `Bearer ${token}` });
beforeAll(async () => { await connect(); });
afterAll(async () => { if (sink) sink.server.close(); await disconnect(); });
beforeEach(async () => {
  await clear();
  A = await seedSchool('Alpha');
  owner = await User.create({ name: 'Owner', email: `o${Date.now()}@e.test`, password: await hashPassword('OwnerPass123'), role: 'superadmin' });
  token = (await api().post('/api/platform/login').send({ email: owner.email, password: 'OwnerPass123' })).body.token;
  if (sink) sink.server.close();
  sink = await smtpSink();
  sink.received.length = 0;
  axios.post.mockReset();
});

const mailBody = (over = {}) => ({ config: { host: '127.0.0.1', port: 2525, security: 'none', username: 'mailer', fromName: 'EduAmigo', fromEmail: 'no-reply@example.test', ...over }, password: 'p@ss-secret-123' });

describe('access', () => {
  test('only the platform owner reaches the integration routes', async () => {
    for (const [m, p] of [['get', '/api/platform/integrations'], ['put', '/api/platform/integrations/email'], ['post', '/api/platform/integrations/email/test'], ['post', '/api/platform/integrations/sms/otp/request'], ['get', '/api/platform/integrations/logs'], ['get', '/api/platform/health']]) {
      expect((await api()[m](p)).status).toBe(401);
      expect((await api()[m](p).set(auth(A.admin))).status).toBe(403); // a school token is refused
    }
  });
});

describe('email settings', () => {
  test('input is validated on the server', async () => {
    const put = (body) => api().put('/api/platform/integrations/email').set(ownerH()).send(body);
    expect((await put({ config: { host: 'not a host!' } })).status).toBe(400);
    expect((await put({ config: { port: 80 } })).status).toBe(400);
    expect((await put({ config: { security: 'plain' } })).status).toBe(400);
    expect((await put({ config: { fromEmail: 'nope' } })).status).toBe(400);
    expect((await put({ config: { timeoutMs: 10 } })).status).toBe(400);
    expect((await put({ config: { provider: 'sendgrid' } })).status).toBe(400);
  });

  test('the password is stored encrypted and never returned; masking survives a read', async () => {
    const res = await api().put('/api/platform/integrations/email').set(ownerH()).send(mailBody());
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain('p@ss-secret-123');
    expect(res.body.data.secretsSet).toEqual({ password: true });
    const raw = await PlatformSetting.findOne({ key: 'email' }).select('+secrets').lean();
    expect(raw.secrets.password).toMatch(/^v1:/);
    expect(raw.secrets.password).not.toContain('secret');
    const read = await api().get('/api/platform/integrations').set(ownerH());
    expect(JSON.stringify(read.body)).not.toContain('p@ss-secret-123');
    // Saving again without a password keeps the stored one.
    await api().put('/api/platform/integrations/email').set(ownerH()).send({ config: { fromName: 'EduAmigo Support' } });
    expect((await PlatformSetting.findOne({ key: 'email' }).select('+secrets').lean()).secrets.password).toBe(raw.secrets.password);
  });

  test('saved is not verified: email cannot be switched on before a successful connection check', async () => {
    await api().put('/api/platform/integrations/email').set(ownerH()).send(mailBody());
    const on = await api().put('/api/platform/integrations/email').set(ownerH()).send({ enabled: true });
    expect(on.status).toBe(409);
    expect((await api().get('/api/platform/integrations').set(ownerH())).body.data.email.state).toBe('unverified');
  });

  test('LOCAL SMTP SINK: a correct login verifies; a wrong password fails with a plain message and no secret', async () => {
    // The port allow-list is for real deployments; the sink listens on a random port, so the stored port is set directly.
    await api().put('/api/platform/integrations/email').set(ownerH()).send(mailBody());
    await PlatformSetting.updateOne({ key: 'email' }, { $set: { 'config.port': sink.port } });
    const ok = await api().post('/api/platform/integrations/email/verify').set(ownerH());
    expect(ok.body.data.ok).toBe(true);
    expect(sink.received).toHaveLength(0); // verifying sends no message
    expect((await PlatformSetting.findOne({ key: 'email' })).status.connectionVerifiedAt).toBeTruthy();

    await api().put('/api/platform/integrations/email').set(ownerH()).send({ password: 'wrong-password-999' });
    await PlatformSetting.updateOne({ key: 'email' }, { $set: { 'config.port': sink.port } });
    const bad = await api().post('/api/platform/integrations/email/verify').set(ownerH());
    expect(bad.body.data.ok).toBe(false);
    expect(bad.body.data.code).toBe('EAUTH');
    expect(JSON.stringify(bad.body)).not.toContain('wrong-password-999');
    const doc = await PlatformSetting.findOne({ key: 'email' });
    expect(doc.status.connectionVerifiedAt).toBeFalsy();
    expect(doc.enabled).toBe(false);
  });

  test('LOCAL SMTP SINK: a test email reaches the server; accepted is not the same as confirmed in an inbox', async () => {
    await api().put('/api/platform/integrations/email').set(ownerH()).send(mailBody());
    await PlatformSetting.updateOne({ key: 'email' }, { $set: { 'config.port': sink.port } });
    await api().post('/api/platform/integrations/email/verify').set(ownerH());
    expect((await api().put('/api/platform/integrations/email').set(ownerH()).send({ enabled: true })).status).toBe(200);
    expect((await api().post('/api/platform/integrations/email/test').set(ownerH()).send({ to: 'not-an-email' })).status).toBe(400);
    const t = await api().post('/api/platform/integrations/email/test').set(ownerH()).send({ to: 'person@example.test' });
    expect(t.body.data.ok).toBe(true);
    expect(sink.received).toHaveLength(1);
    expect(sink.received[0].to[0]).toContain('person@example.test');
    expect(sink.received[0].body).toContain('EduAmigo test email');
    let state = (await api().get('/api/platform/integrations').set(ownerH())).body.data.email;
    expect(state.state).toBe('connected'); // not "verified" until a person confirms the inbox
    expect(state.status.lastAcceptedAt).toBeTruthy();
    const confirmed = await api().post('/api/platform/integrations/email/confirm').set(ownerH());
    expect(confirmed.body.data.state).toBe('verified');
  });

  test('changing the server or login clears the verification and switches email off', async () => {
    await api().put('/api/platform/integrations/email').set(ownerH()).send(mailBody());
    await PlatformSetting.updateOne({ key: 'email' }, { $set: { 'config.port': sink.port } });
    await api().post('/api/platform/integrations/email/verify').set(ownerH());
    await api().put('/api/platform/integrations/email').set(ownerH()).send({ enabled: true });
    await api().put('/api/platform/integrations/email').set(ownerH()).send({ config: { username: 'someone-else' } });
    const doc = await PlatformSetting.findOne({ key: 'email' });
    expect(doc.enabled).toBe(false);
    expect(doc.status.connectionVerifiedAt).toBeFalsy();
  });

  test('SSRF guard: private and internal addresses are refused unless explicitly allowed for local development', async () => {
    process.env.ALLOW_PRIVATE_SMTP_HOSTS = 'false';
    try {
      for (const host of ['127.0.0.1', '10.0.0.5', '192.168.1.10', '169.254.169.254', '172.16.0.1']) {
        await api().put('/api/platform/integrations/email').set(ownerH()).send(mailBody({ host, port: 587, security: 'starttls' }));
        const r = await api().post('/api/platform/integrations/email/verify').set(ownerH());
        expect(r.body.data).toMatchObject({ ok: false, code: 'EBLOCKED' });
      }
    } finally { process.env.ALLOW_PRIVATE_SMTP_HOSTS = 'true'; }
  });

  test('password reset email goes through the saved SMTP settings when they are on', async () => {
    await api().put('/api/platform/integrations/email').set(ownerH()).send(mailBody());
    await PlatformSetting.updateOne({ key: 'email' }, { $set: { 'config.port': sink.port } });
    await api().post('/api/platform/integrations/email/verify').set(ownerH());
    await api().put('/api/platform/integrations/email').set(ownerH()).send({ enabled: true });
    const { sendEmail } = require('../src/services/email');
    const r = await sendEmail({ to: 'parent@example.test', subject: 'Your password reset code', text: 'code 123456' });
    expect(r).toMatchObject({ delivered: true, provider: 'smtp' });
    expect(sink.received[0].body).toContain('code 123456');
  });

  test('logs and audit entries exist, hold no secret, and are for the owner only', async () => {
    await api().put('/api/platform/integrations/email').set(ownerH()).send(mailBody());
    await api().post('/api/platform/integrations/email/test').set(ownerH()).send({ to: 'person@example.test' });
    const logs = await api().get('/api/platform/integrations/logs?kind=email').set(ownerH());
    expect(logs.body.data.length).toBeGreaterThan(1);
    const text = JSON.stringify(logs.body) + JSON.stringify(await AuditLog.find({}).lean());
    expect(text).not.toContain('p@ss-secret-123');
    expect(text).not.toContain('person@example.test'); // recipients are masked
    expect(await AuditLog.countDocuments({ action: 'platform.integration_saved' })).toBe(1);
    expect((await api().get('/api/platform/integrations/logs').set(auth(A.admin))).status).toBe(403);
  });
});

describe('SMS settings and phone codes', () => {
  const putSms = (body) => api().put('/api/platform/integrations/sms').set(ownerH()).send(body);
  const request = (phone) => api().post('/api/platform/integrations/sms/otp/request').set(ownerH()).send({ phone });
  const verify = (phone, code) => api().post('/api/platform/integrations/sms/otp/verify').set(ownerH()).send({ phone, code });

  test('settings are validated; the API key is stored encrypted and never returned', async () => {
    expect((await putSms({ config: { provider: 'nexmo' } })).status).toBe(400);
    expect((await putSms({ config: { otpExpirySeconds: 5 } })).status).toBe(400);
    expect((await putSms({ config: { maxAttempts: 99 } })).status).toBe(400);
    expect((await putSms({ config: { provider: 'msg91', templateId: 'abc 123!' } })).status).toBe(400);
    const res = await putSms({ config: { provider: 'msg91', templateId: 'tpl_1', senderId: 'EDUAMG' }, apiKey: 'authkey-SECRET-777' });
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain('authkey-SECRET-777');
    expect(res.body.data.secretsSet).toEqual({ apiKey: true });
    expect((await PlatformSetting.findOne({ key: 'sms' }).select('+secrets').lean()).secrets.apiKey).toMatch(/^v1:/);
  });

  test('a real provider cannot be switched on without its required settings, nor straight into production', async () => {
    expect((await putSms({ enabled: true, config: { provider: 'msg91' } })).status).toBe(400);
    expect((await putSms({ enabled: true, config: { provider: 'twilio' }, apiKey: 'k' })).status).toBe(400);
    expect((await putSms({ enabled: true, config: { provider: 'msg91', templateId: 't', mode: 'production' }, apiKey: 'k' })).status).toBe(409);
  });

  test('TEST MODE: a code is created, nothing leaves the server, and the right code verifies exactly once', async () => {
    await putSms({ enabled: true, config: { provider: 'test', mode: 'test' } });
    const r = await request('9876543210');
    expect(r.status).toBe(200);
    expect(r.body.data.simulated).toBe(true);
    expect(r.body.data.testCode).toMatch(/^\d{6}$/);
    expect(axios.post).not.toHaveBeenCalled();
    const code = r.body.data.testCode;
    expect((await verify('9876543210', code)).status).toBe(200);
    expect((await verify('9876543210', code)).status).toBe(400); // replay
    const rows = await PhoneOtp.find({}).lean();
    expect(JSON.stringify(rows)).not.toContain(code);
    expect(JSON.stringify(rows)).not.toContain('9876543210');
  });

  test('wrong code, bad format, expiry and attempt limit are all refused', async () => {
    await putSms({ config: { provider: 'test', mode: 'test', maxAttempts: 3, resendCooldownSeconds: 15 } });
    const { body } = await request('+919876543210');
    const code = body.data.testCode;
    const wrong = code === '000000' ? '111111' : '000000';
    expect((await verify('+919876543210', 'abc')).status).toBe(400);
    expect((await verify('+919876543210', wrong)).status).toBe(400);
    expect((await verify('+919876543210', wrong)).status).toBe(400);
    expect((await verify('+919876543210', wrong)).status).toBe(400);
    expect((await verify('+919876543210', code)).status).toBe(429); // locked even for the right code
    // expiry
    await PhoneOtp.deleteMany({});
    const r2 = await request('+919812345678');
    await PhoneOtp.updateMany({}, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await verify('+919812345678', r2.body.data.testCode)).status).toBe(400);
  });

  test('resend cooldown, hourly cap, and an older code stops working when a new one is issued', async () => {
    await putSms({ config: { provider: 'test', mode: 'test', resendCooldownSeconds: 60, hourlyLimitPerPhone: 2 } });
    const first = await request('9876543211');
    const again = await request('9876543211');
    expect(again.status).toBe(429);
    expect(again.body.retryAfterSeconds).toBeGreaterThan(0);
    await PhoneOtp.updateMany({}, { $set: { sentAt: new Date(Date.now() - 120000) } });
    const second = await request('9876543211');
    expect(second.status).toBe(200);
    expect((await verify('9876543211', first.body.data.testCode)).status).toBe(400); // replaced by the newer code
    await PhoneOtp.updateMany({}, { $set: { sentAt: new Date(Date.now() - 120000) } });
    expect((await request('9876543211')).status).toBe(429); // 2 per hour reached
  });

  test('answers are the same for any number: no account is looked up, so none can be revealed', async () => {
    await putSms({ config: { provider: 'test', mode: 'test' } });
    const a = await request('9876543212');
    const b = await request('9000000099');
    expect(Object.keys(a.body.data).sort()).toEqual(Object.keys(b.body.data).sort());
    expect((await verify('9000000077', '123456')).body.message).toBe((await verify('9876543299', '123456')).body.message);
  });

  test('MOCKED PROVIDER (MSG91): production mode sends the right request; a rejection is shown without any secret', async () => {
    await putSms({ config: { provider: 'msg91', templateId: 'tpl_1', senderId: 'EDUAMG', mode: 'test' }, apiKey: 'authkey-SECRET-777' });
    axios.post.mockResolvedValue({ data: { type: 'success' } });
    await PlatformSetting.updateOne({ key: 'sms' }, { $set: { 'config.mode': 'production', enabled: true } });
    const ok = await request('9876543213');
    expect(ok.status).toBe(200);
    expect(ok.body.data.testCode).toBeUndefined(); // the code is never shown when a real provider is used
    const [url, , cfg] = axios.post.mock.calls[0];
    expect(url).toBe('https://control.msg91.com/api/v5/otp');
    expect(cfg.params).toMatchObject({ template_id: 'tpl_1', mobile: '919876543213' });
    expect(cfg.headers.authkey).toBe('authkey-SECRET-777');
    expect(cfg.maxRedirects).toBe(0); // a redirect must never carry the key to another host
    await PhoneOtp.deleteMany({});
    axios.post.mockRejectedValue(Object.assign(new Error('Invalid authkey-SECRET-777 for 919876543214'), { code: 'EPROVIDER' }));
    const bad = await request('9876543214');
    expect(bad.status).toBe(502);
    expect(JSON.stringify(bad.body)).not.toContain('authkey-SECRET-777');
    expect(JSON.stringify(await IntegrationLog.find({}).lean())).not.toContain('authkey-SECRET-777');
    expect(await PhoneOtp.countDocuments({})).toBe(0); // a code that could not be sent is not kept
  });

  test('MOCKED PROVIDER (Twilio): request shape', async () => {
    await putSms({ config: { provider: 'twilio', accountSid: 'AC123', senderId: '+15005550006' }, apiKey: 'tok' });
    await PlatformSetting.updateOne({ key: 'sms' }, { $set: { 'config.mode': 'production', enabled: true } });
    axios.post.mockResolvedValue({ data: {} });
    expect((await request('+14155550100')).status).toBe(200);
    const [url, body, cfg] = axios.post.mock.calls[0];
    expect(url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json');
    expect(body).toContain('To=%2B14155550100');
    expect(cfg.auth).toEqual({ username: 'AC123', password: 'tok' });
  });
});

describe('review hardening', () => {
  const putSms = (body) => api().put('/api/platform/integrations/sms').set(ownerH()).send(body);
  const request = (phone, live) => api().post('/api/platform/integrations/sms/otp/request').set(ownerH()).send({ phone, ...(live ? { live: true } : {}) });

  test('SSRF guard: every spelling of a local address is judged by what it resolves to', async () => {
    process.env.ALLOW_PRIVATE_SMTP_HOSTS = 'false';
    const { isPrivateAddress } = require('../src/services/netGuard');
    try {
      for (const ip of ['127.0.0.1', '::1', '::ffff:7f00:1', '::ffff:127.0.0.1', '10.1.2.3', '169.254.169.254', 'fd00::1', 'fe80::1', '100.64.0.1', '0.0.0.0', '224.0.0.1', '64:ff9b::7f00:1']) expect(isPrivateAddress(ip)).toBe(true);
      for (const ip of ['8.8.8.8', '2606:4700:4700::1111', '::ffff:808:808']) expect(isPrivateAddress(ip)).toBe(false);
      for (const host of ['localhost', '127.1', '2130706433', '0x7f.1']) {
        await api().put('/api/platform/integrations/email').set(ownerH()).send(mailBody({ host, port: 587, security: 'starttls' }));
        const r = await api().post('/api/platform/integrations/email/verify').set(ownerH());
        expect(r.body.data.ok).toBe(false);
        expect(['EBLOCKED', 'EDNS']).toContain(r.body.data.code);
      }
    } finally { process.env.ALLOW_PRIVATE_SMTP_HOSTS = 'true'; }
  });

  test('key rotation: a password saved under another key is reported as unreadable, not as a bad login, and can be re-entered', async () => {
    const old = process.env.DATA_ENCRYPTION_KEY;
    process.env.DATA_ENCRYPTION_KEY = 'a'.repeat(40);
    await api().put('/api/platform/integrations/email').set(ownerH()).send(mailBody());
    await PlatformSetting.updateOne({ key: 'email' }, { $set: { 'config.port': sink.port } });
    process.env.DATA_ENCRYPTION_KEY = 'b'.repeat(40);
    try {
      const view = (await api().get('/api/platform/integrations').set(ownerH())).body.data.email;
      expect(view.secretsUnreadable).toEqual({ password: true });
      const r = await api().post('/api/platform/integrations/email/verify').set(ownerH());
      expect(r.body.data).toMatchObject({ ok: false, code: 'EKEY' });
      expect(r.body.data.message).toMatch(/Enter it again/);
      await api().put('/api/platform/integrations/email').set(ownerH()).send({ password: 'p@ss-secret-123' });
      await PlatformSetting.updateOne({ key: 'email' }, { $set: { 'config.port': sink.port } });
      expect((await api().post('/api/platform/integrations/email/verify').set(ownerH())).body.data.ok).toBe(true);
    } finally { if (old === undefined) delete process.env.DATA_ENCRYPTION_KEY; else process.env.DATA_ENCRYPTION_KEY = old; }
  });

  test('production refuses to store a secret without its own strong encryption key', async () => {
    const env = process.env.NODE_ENV; const key = process.env.DATA_ENCRYPTION_KEY;
    delete process.env.DATA_ENCRYPTION_KEY; process.env.NODE_ENV = 'production';
    try {
      const r = await api().put('/api/platform/integrations/email').set(ownerH()).send({ ...mailBody({ security: 'starttls', port: 587 }) });
      expect(r.status).toBe(503);
      expect((await PlatformSetting.findOne({ key: 'email' }))?.secrets).toBeUndefined();
    } finally { process.env.NODE_ENV = env; if (key !== undefined) process.env.DATA_ENCRYPTION_KEY = key; }
  });

  test('provider text that echoes an address or number is masked in the response and the log', async () => {
    const { describeError } = require('../src/services/integrations');
    const d = describeError(new Error('550 5.1.1 <person@example.test> unknown; call +919876543210'));
    expect(d.message).not.toContain('person@example.test');
    expect(d.message).not.toContain('9876543210');
  });

  test('TEST MODE cannot send: a real provider that is saved but not switched on, or in test mode, is simulated', async () => {
    axios.post.mockResolvedValue({ data: { type: 'success' } });
    await putSms({ config: { provider: 'msg91', templateId: 't', mode: 'test' }, apiKey: 'k-1234' });
    expect((await request('9876543215')).body.data.simulated).toBe(true);
    await PlatformSetting.updateOne({ key: 'sms' }, { $set: { 'config.mode': 'production', enabled: false } });
    await PhoneOtp.deleteMany({});
    expect((await request('9876543215')).body.data.simulated).toBe(true); // production mode but switched off
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('a real send needs the explicit "live" request, a real provider, and production needs one accepted real send first', async () => {
    expect((await request('9876543216', true)).status).toBe(400); // provider "test"
    await putSms({ config: { provider: 'msg91', templateId: 't', mode: 'test' }, apiKey: 'k-1234' });
    expect((await putSms({ enabled: true, config: { mode: 'production' } })).status).toBe(409);
    axios.post.mockResolvedValue({ data: { type: 'success' } });
    const live = await request('9876543216', true);
    expect(live.status).toBe(200);
    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(live.body.data.testCode).toBeUndefined();
    expect((await putSms({ enabled: true, config: { mode: 'production' } })).status).toBe(200);
  });

  test('two code requests at the same instant produce one code', async () => {
    await putSms({ config: { provider: 'test', mode: 'test', resendCooldownSeconds: 60 } });
    const [a, b] = await Promise.all([request('9876543217'), request('9876543217')]);
    expect([a.status, b.status].sort()).toEqual([200, 429]);
    expect(await PhoneOtp.countDocuments({})).toBe(1);
  });

  test('provider-contacting actions are rate limited per owner account', async () => {
    process.env.ENABLE_RATE_LIMIT_IN_TESTS = 'true'; process.env.INTEGRATION_TESTS_PER_15_MIN = '3';
    try {
      const codes = [];
      for (let i = 0; i < 5; i++) codes.push((await api().post('/api/platform/integrations/email/sender-check').set(ownerH())).status);
      expect(codes.slice(3)).toEqual([429, 429]);
    } finally { delete process.env.ENABLE_RATE_LIMIT_IN_TESTS; delete process.env.INTEGRATION_TESTS_PER_15_MIN; }
  });

  test('a failed saved-SMTP send surfaces as a failure and does not silently fall back (password reset keeps its existing error handling)', async () => {
    await api().put('/api/platform/integrations/email').set(ownerH()).send(mailBody());
    await PlatformSetting.updateOne({ key: 'email' }, { $set: { 'config.port': sink.port, enabled: true, 'status.connectionVerifiedAt': new Date() } });
    sink.server.close(); sink = null;
    const { sendEmail } = require('../src/services/email');
    await expect(sendEmail({ to: 'a@example.test', subject: 's', text: 't' })).rejects.toBeTruthy();
  });
});

describe('platform health', () => {
  test('reports what was measured and lists what was not; integrations are not green without evidence', async () => {
    const res = await api().get('/api/platform/health').set(ownerH());
    expect(res.body.data.database.ok).toBe(true);
    expect(res.body.data.notMeasured.length).toBeGreaterThan(0);
    expect(['unconfigured', 'unverified']).toContain(res.body.data.integrations.email);
  });
});
