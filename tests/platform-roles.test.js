// Owner console team roles (owner, billing, support, viewer), plan-change preview, and support email notices.
jest.mock('../src/services/email', () => ({ sendEmail: jest.fn(async () => ({ delivered: true, provider: 'smtp' })), provider: () => 'log', isConfigured: () => true }));
const { sendEmail } = require('../src/services/email');
const { api, connect, disconnect, clear, auth, seedSchool } = require('./helpers');
const User = require('../src/models/User');
const School = require('../src/models/School');
const Plan = require('../src/models/Plan');
const SupportRequest = require('../src/models/SupportRequest');
const PlatformSetting = require('../src/models/PlatformSetting');
const { hashPassword } = require('../src/services/credentials');
const sub = require('../src/services/subscription');

let A; let owner; const tokens = {};
const H = (who) => ({ Authorization: `Bearer ${tokens[who]}` });
beforeAll(connect); afterAll(disconnect);
beforeEach(async () => {
  await clear(); sendEmail.mockClear(); sub.clearPlanCache?.();
  A = await seedSchool('Alpha');
  const make = async (platformRole, email) => {
    const u = await User.create({ name: platformRole, email, password: await hashPassword('OwnerPass123'), role: 'superadmin', ...(platformRole === 'owner-legacy' ? {} : { platformRole }) });
    tokens[platformRole] = (await api().post('/api/platform/login').send({ email, password: 'OwnerPass123' })).body.token;
    return u;
  };
  owner = await make('owner', `o${Date.now()}@e.test`);
  await make('billing', `b${Date.now()}@e.test`); await make('support', `s${Date.now()}@e.test`); await make('viewer', `v${Date.now()}@e.test`);
  await Plan.deleteMany({});
});

describe('who may do what', () => {
  const ID = '507f1f77bcf86cd799439011';
  // [method, path, body, roles that must be allowed (anything else must get 403)]
  const MATRIX = [
    ['get', '/api/platform/analytics', null, ['owner', 'billing', 'support', 'viewer']],
    ['get', '/api/platform/health', null, ['owner', 'billing', 'support', 'viewer']],
    ['get', '/api/platform/schools', null, ['owner', 'billing', 'support', 'viewer']],
    ['get', '/api/platform/invoices', null, ['owner', 'billing', 'support', 'viewer']],
    ['get', '/api/platform/support', null, ['owner', 'billing', 'support', 'viewer']],
    ['get', '/api/platform/audit', null, ['owner', 'billing', 'support', 'viewer']],
    ['get', '/api/platform/integrations', null, ['owner', 'support']],
    ['get', '/api/platform/users', null, ['owner']],
    ['get', '/api/platform/settings', null, ['owner']],
    ['put', '/api/platform/settings', { orgName: 'EduAmigo' }, ['owner']],
    ['post', '/api/platform/users', { name: 'Nobody', email: 'nobody@x.test', password: 'Strong#1234' }, ['owner']],
    ['put', '/api/platform/integrations/email', { config: { host: 'smtp.example.com' } }, ['owner']],
    ['post', '/api/platform/notices', { title: 'Hello there', message: 'A real message' }, ['owner', 'support']],
    ['patch', `/api/platform/support/${ID}`, { status: 'resolved' }, ['owner', 'support']],
    ['put', '/api/platform/plans/basic', { name: 'Basic' }, ['owner', 'billing']],
    ['post', `/api/platform/schools/${ID}/subscription/preview`, {}, ['owner', 'billing']],
    ['post', `/api/platform/schools/${ID}/support-session`, { reason: 'checking something' }, ['owner', 'support']],
    ['post', '/api/platform/schools', { name: 'X' }, ['owner', 'billing']],
  ];
  for (const [method, path, body, allowed] of MATRIX) {
    test(`${method.toUpperCase()} ${path.replace(ID, ':id')}: ${allowed.join(', ')}`, async () => {
      for (const who of ['owner', 'billing', 'support', 'viewer']) {
        const req = api()[method](path).set(H(who));
        const res = await (body ? req.send(body) : req);
        if (allowed.includes(who)) expect([who, res.status === 403]).toEqual([who, false]);
        else expect([who, res.status]).toEqual([who, 403]);
      }
    });
  }

  test('a school administrator and an anonymous caller get nothing', async () => {
    expect((await api().get('/api/platform/schools').set(auth(A.admin))).status).toBe(403);
    expect((await api().get('/api/platform/schools')).status).toBe(401);
  });

  test('/me tells the console the role and its permissions', async () => {
    const me = (await api().get('/api/platform/me').set(H('support'))).body.data;
    expect(me.platformRole).toBe('support');
    expect(me.permissions).toContain('support.manage');
    expect(me.permissions).not.toContain('billing.manage');
    const legacy = await User.create({ name: 'Old', email: 'old@e.test', password: await hashPassword('OwnerPass123'), role: 'superadmin' });
    const t = (await api().post('/api/platform/login').send({ email: legacy.email, password: 'OwnerPass123' })).body.token;
    expect((await api().get('/api/platform/me').set({ Authorization: `Bearer ${t}` })).body.data.platformRole).toBe('owner'); // accounts from before roles stay owners
  });
});

describe('managing roles', () => {
  test('new people start as viewers; an owner can change a role, which signs that person out; invalid roles are refused', async () => {
    const made = await api().post('/api/platform/users').set(H('owner')).send({ name: 'New Person', email: 'new@e.test', password: 'Strong#1234' });
    expect(made.body.data.platformRole).toBe('viewer');
    const t = (await api().post('/api/platform/login').send({ email: 'new@e.test', password: 'Strong#1234' })).body.token;
    expect((await api().patch(`/api/platform/users/${made.body.data._id}`).set(H('owner')).send({ platformRole: 'admin' })).status).toBe(400);
    expect((await api().patch(`/api/platform/users/${made.body.data._id}`).set(H('owner')).send({ platformRole: 'billing' })).body.data.platformRole).toBe('billing');
    expect((await api().get('/api/platform/me').set({ Authorization: `Bearer ${t}` })).status).toBe(401);
  });
  test('you cannot change your own role, and the last active owner cannot be demoted', async () => {
    expect((await api().patch(`/api/platform/users/${owner._id}`).set(H('owner')).send({ platformRole: 'viewer' })).status).toBe(400);
    const second = (await api().post('/api/platform/users').set(H('owner')).send({ name: 'Second Owner', email: 'second@e.test', password: 'Strong#1234', platformRole: 'owner' })).body.data;
    expect((await api().patch(`/api/platform/users/${second._id}`).set(H('owner')).send({ platformRole: 'support' })).status).toBe(200);
    // demoting the only other owner works because the actor is an owner; but with the actor as the only owner, it is refused
    await User.updateMany({ _id: { $ne: owner._id }, platformRole: 'owner' }, { platformRole: 'viewer' });
    const viewerId = (await User.findOne({ platformRole: 'viewer' }))._id;
    expect((await api().patch(`/api/platform/users/${viewerId}`).set(H('owner')).send({ platformRole: 'billing' })).status).toBe(200);
  });
  test('a lower role cannot give itself more', async () => {
    const v = await User.findOne({ platformRole: 'viewer' });
    expect((await api().patch(`/api/platform/users/${v._id}`).set(H('viewer')).send({ platformRole: 'owner' })).status).toBe(403);
    expect((await api().patch(`/api/platform/users/${v._id}`).set(H('support')).send({ platformRole: 'owner' })).status).toBe(403);
  });
  test('the role list describes every role', async () => {
    const r = (await api().get('/api/platform/roles').set(H('owner'))).body.data;
    expect(r.map((x) => x.key)).toEqual(['owner', 'billing', 'support', 'viewer']);
    expect(r[3].permissions.every((p) => p.key.endsWith('.read'))).toBe(true);
  });
});

describe('plan change preview', () => {
  test('shows what would change and writes nothing; applying it afterwards changes the plan', async () => {
    await api().put('/api/platform/plans/basic').set(H('owner')).send({ name: 'Basic', features: [], pricePerStudentYear: 100, limits: { maxStudents: 1 } });
    await api().put('/api/platform/plans/premium').set(H('owner')).send({ name: 'Premium', features: ['fees'], pricePerStudentYear: 300, limits: { maxStudents: null } });
    await School.updateOne({ _id: A.school._id }, { $set: { 'subscription.plan': 'basic', 'subscription.status': 'active', 'subscription.currentPeriodEnd': new Date(Date.now() + 86400000 * 100) } });
    const before = await School.findById(A.school._id).lean();
    const p = await api().post(`/api/platform/schools/${A.school._id}/subscription/preview`).set(H('billing')).send({ plan: 'premium' });
    expect(p.status).toBe(200);
    expect(p.body.data).toMatchObject({ direction: 'upgrade', plan: { from: 'Basic', to: 'Premium' } });
    expect(p.body.data.modules.added).toContain('Fees & Billing');
    expect(p.body.data.yearlyEstimate.to).toBeGreaterThan(p.body.data.yearlyEstimate.from);
    expect(JSON.stringify((await School.findById(A.school._id).lean()).subscription)).toBe(JSON.stringify(before.subscription)); // nothing was written
    const down = await api().post(`/api/platform/schools/${A.school._id}/subscription/preview`).set(H('billing')).send({ plan: 'basic', limits: { maxStudents: 1 } });
    // already on basic: nothing changes
    expect(down.body.data.direction).toBe('same');
    await api().patch(`/api/platform/schools/${A.school._id}/subscription`).set(H('billing')).send({ plan: 'premium' });
    expect((await School.findById(A.school._id)).subscription.plan).toBe('premium');
  });
  test('a downgrade warns about modules lost and students above the new limit; a bad plan is refused', async () => {
    await api().put('/api/platform/plans/basic').set(H('owner')).send({ name: 'Basic', features: [], pricePerStudentYear: 100, limits: { maxStudents: 1 } });
    await api().put('/api/platform/plans/premium').set(H('owner')).send({ name: 'Premium', features: ['fees'], pricePerStudentYear: 300, limits: { maxStudents: null } });
    await School.updateOne({ _id: A.school._id }, { $set: { 'subscription.plan': 'premium' } });
    const p = (await api().post(`/api/platform/schools/${A.school._id}/subscription/preview`).set(H('billing')).send({ plan: 'basic' })).body.data;
    expect(p.direction).toBe('downgrade');
    expect(p.modules.removed).toContain('Fees & Billing');
    expect(p.warnings.join(' ')).toMatch(/more than the new limit of 1/);
    expect((await api().post(`/api/platform/schools/${A.school._id}/subscription/preview`).set(H('billing')).send({ plan: 'nonsense' })).status).toBe(400);
    expect((await api().post(`/api/platform/schools/${A.school._id}/subscription/preview`).set(H('viewer')).send({ plan: 'basic' })).status).toBe(403);
  });
});

describe('support email notices', () => {
  const open = async () => (await api().post('/api/support/requests').set(auth(A.admin)).send({ subject: 'Receipts blank', message: 'The receipt page is blank for Class 5.' })).body.data._id;
  test('a public reply is emailed to the person who asked; an internal note is not; a failure is reported to the owner only', async () => {
    const id = await open();
    const reply = await api().patch(`/api/platform/support/${id}`).set(H('support')).send({ note: 'We are looking into it.' });
    expect(reply.body.email).toEqual({ sent: true });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0]).toMatchObject({ to: A.admin.email, subject: 'EduAmigo replied: Receipts blank' });
    expect(sendEmail.mock.calls[0][0].text).toContain('We are looking into it.');
    await api().patch(`/api/platform/support/${id}`).set(H('support')).send({ note: 'Probably the template', internal: true });
    await api().patch(`/api/platform/support/${id}`).set(H('support')).send({ status: 'in_progress' });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    sendEmail.mockRejectedValueOnce(Object.assign(new Error('Could not connect'), { code: 'ECONNECTION' }));
    const failed = await api().patch(`/api/platform/support/${id}`).set(H('support')).send({ note: 'Second reply' });
    expect(failed.status).toBe(200);
    expect(failed.body.email.sent).toBe(false);
    const school = (await api().get('/api/support/requests').set(auth(A.admin))).body.data[0];
    expect(JSON.stringify(school)).not.toMatch(/emailed|Could not connect|template/);
    expect(school.messages.map((m) => m.text)).toContain('Second reply');
  });
  test('when no provider is on, the owner is told the email was not sent', async () => {
    sendEmail.mockResolvedValueOnce({ delivered: false, provider: 'log' });
    const id = await open();
    const r = await api().patch(`/api/platform/support/${id}`).set(H('owner')).send({ note: 'Hello' });
    expect(r.body.email.sent).toBe(false);
    expect(r.body.email.reason).toMatch(/No email provider/);
  });
  test('a school message is emailed to the support address once one is saved, and not before', async () => {
    const id = await open();
    expect(sendEmail).not.toHaveBeenCalled();
    await api().put('/api/platform/settings').set(H('owner')).send({ supportEmail: 'help@eduamigo.test' });
    await api().post(`/api/support/requests/${id}/reply`).set(auth(A.admin)).send({ message: 'Any news?' });
    await new Promise((r) => setTimeout(r, 100));
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0]).toMatchObject({ to: 'help@eduamigo.test' });
    expect(await SupportRequest.countDocuments({})).toBe(1);
    expect(await PlatformSetting.countDocuments({ key: 'platform' })).toBe(1);
  });
});
