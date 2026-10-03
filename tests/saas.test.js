const jwt = require('jsonwebtoken');
const { api, connect, disconnect, clear, auth, seedSchool, makeUser } = require('./helpers');
const School = require('../src/models/School');
const User = require('../src/models/User');
const Fee = require('../src/models/Fee');
const AuditLog = require('../src/models/AuditLog');
const UsageCounter = require('../src/models/UsageCounter');
const Transport = require('../src/models/Transport');
const { hashPassword } = require('../src/services/credentials');
const { clearPlanCache, monthKey } = require('../src/services/subscription');
const { clearDomainCache } = require('../src/services/schoolDirectory');
const { sendFeeReminders } = require('../src/jobs/feeReminder');
const { migrate } = require('../src/scripts/migrate');

const DAY = 86400000;
let A;

beforeAll(connect);
afterAll(disconnect);
beforeEach(async () => {
  await clear();
  clearPlanCache();
  clearDomainCache();
  A = await seedSchool('Alpha School');
});

const setSub = (school, sub) => School.updateOne({ _id: school._id }, { $set: Object.fromEntries(Object.entries(sub).map(([k, v]) => [`subscription.${k}`, v])) });

async function makePlatformAdmin() {
  const user = await User.create({ name: 'Owner', email: `owner${Date.now()}@eduamigo.in`, role: 'superadmin', school: null, password: await hashPassword('OwnerPass123') });
  const login = await api().post('/api/platform/login').send({ email: user.email, password: 'OwnerPass123' });
  return { user, headers: { Authorization: `Bearer ${login.body.token}` } };
}

describe('school codes and public lookup', () => {
  test('every new school gets a unique code generated from its name', async () => {
    const a = await School.findById(A.school._id);
    expect(a.code).toBe('ALP');
    const gv1 = await School.create({ name: 'Green Valley Public School' });
    const gv2 = await School.create({ name: 'Green Valley Public School' });
    expect(gv1.code).toBe('GVPS');
    expect(gv2.code).toMatch(/^GVPS\d+$/);
  });

  test('a school can be found by code, name search or its own domain, with public fields only', async () => {
    await School.updateOne({ _id: A.school._id }, { city: 'Jaipur', customDomain: 'erp.alpha.edu.in', branding: { appName: 'Alpha App', primaryColor: '#123456' } });
    const byCode = await api().get('/api/public/schools/alp');
    expect(byCode.status).toBe(200);
    expect(byCode.body.data).toEqual({ code: 'ALP', name: 'Alpha School', city: 'Jaipur', appName: 'Alpha App', logoUrl: '', primaryColor: '#123456', accentColor: '', tagline: '', heroStyle: 'bold' });

    const search = await api().get('/api/public/schools?search=alph');
    expect(search.body.data.map((s) => s.code)).toEqual(['ALP']);
    expect((await api().get('/api/public/schools?search=al')).body.data).toEqual([]); // too short

    const byDomain = await api().get('/api/public/schools/by-domain?host=ERP.alpha.edu.in');
    expect(byDomain.body.data.code).toBe('ALP');
  });

  test('suspended schools are hidden from lookup and search', async () => {
    await setSub(A.school, { status: 'suspended' });
    expect((await api().get('/api/public/schools/ALP')).status).toBe(404);
    expect((await api().get('/api/public/schools?search=alpha')).body.data).toEqual([]);
  });

  test('browsers on a school\'s own domain pass CORS; unknown origins do not', async () => {
    const prev = process.env.CORS_ORIGINS;
    process.env.CORS_ORIGINS = 'https://app.eduamigo.in';
    try {
      const buildApp = require('../src/app');
      const request = require('supertest');
      const app = buildApp();
      await School.updateOne({ _id: A.school._id }, { customDomain: 'erp.alpha.edu.in' });
      const ok = await request(app).get('/api/health').set('Origin', 'https://erp.alpha.edu.in');
      expect(ok.headers['access-control-allow-origin']).toBe('https://erp.alpha.edu.in');
      const bad = await request(app).get('/api/health').set('Origin', 'https://evil.example.com');
      expect(bad.headers['access-control-allow-origin']).toBeUndefined();
    } finally {
      process.env.CORS_ORIGINS = prev;
    }
  });
});

describe('plans and features', () => {
  test('a new school starts on a full-featured trial; login returns plan, features and branding', async () => {
    const res = await api().post('/api/users/login').send({ email: A.admin.email, password: 'Password123' });
    expect(res.status).toBe(200);
    expect(res.body.user.plan.code).toBe('premium');
    expect(res.body.user.subscription.status).toBe('trial');
    expect(res.body.user.features).toContain('fees');
    expect(res.body.user.schoolCode).toBe('ALP');
    expect(res.body.user.permissions).toContain('fees.collect');
  });

  test('basic plan: paid modules answer FEATURE_NOT_IN_PLAN, core modules keep working, menus are hidden', async () => {
    await setSub(A.school, { plan: 'basic' });
    const fees = await api().get('/api/fees').set(auth(A.admin));
    expect(fees.status).toBe(403);
    expect(fees.body.code).toBe('FEATURE_NOT_IN_PLAN');
    expect(fees.body.feature).toBe('fees');
    for (const path of ['/api/exams', '/api/admissions', '/api/hr/salaries', '/api/library', '/api/transport', '/api/chat/unread-count']) {
      expect((await api().get(path).set(auth(A.admin))).status).toBe(403);
    }
    expect((await api().get('/api/students').set(auth(A.admin))).status).toBe(200);
    expect((await api().get('/api/attendance/today').set(auth(A.admin))).status).toBe(200);

    const profile = await api().get('/api/users/profile').set(auth(A.admin));
    expect(profile.body.data.features).toEqual([]);
    expect(profile.body.data.permissions).not.toContain('fees.collect');
    expect(profile.body.data.permissions).toContain('students.manage');
  });

  test('add-ons and per-school overrides change features; online payments need fees', async () => {
    await setSub(A.school, { plan: 'basic', addOns: ['transport', 'online_payments'] });
    expect((await api().get('/api/transport').set(auth(A.admin))).status).toBe(200);
    let profile = await api().get('/api/users/profile').set(auth(A.admin));
    expect(profile.body.data.features).toEqual(['transport']); // online_payments dropped: no fees

    await setSub(A.school, { plan: 'standard', addOns: ['online_payments'], disabledFeatures: ['chat'] });
    profile = await api().get('/api/users/profile').set(auth(A.admin));
    expect(profile.body.data.features).toEqual(['admissions', 'exams', 'fees', 'online_payments']);
    expect((await api().get('/api/chat/unread-count').set(auth(A.admin))).status).toBe(403);
  });

  test('payment config says "disabled" instead of failing when online payments are not in the plan', async () => {
    await setSub(A.school, { plan: 'standard' });
    const res = await api().get('/api/payments/config').set(auth(A.parentUser));
    expect(res.status).toBe(200);
    expect(res.body.data.enabled).toBe(false);
    expect((await api().post('/api/payments/orders').set(auth(A.parentUser)).send({})).status).toBe(403);
  });

  test('student limit of the plan is enforced when adding students', async () => {
    await setSub(A.school, { limits: { maxStudents: 2, aiQuestionsPerMonth: null } });
    const res = await api().post('/api/students').set(auth(A.admin)).send({
      name: 'Third', email: 'third@test.local', phone: '9000000009', rollNumber: '9', class: '10', section: 'A',
    });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PLAN_LIMIT');
  });

  test('monthly AI question allowance is enforced per school', async () => {
    await setSub(A.school, { limits: { maxStudents: null, aiQuestionsPerMonth: 3 } });
    await UsageCounter.create({ school: A.school._id, metric: 'ai_questions', period: monthKey(), count: 3 });
    const res = await api().post('/api/revision/ask').set(auth(A.studentUser)).send({ question: 'What is photosynthesis?' });
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('PLAN_LIMIT');
  });

  test('the transport driver app stops working when the school has no transport', async () => {
    const bus = await Transport.create({ school: A.school._id, busNumber: 'RJ14 1234', driverName: 'Ram', driverPhone: '9000000010', driverToken: 'BUS-TOKEN-123', routeName: 'R1' });
    expect((await api().get(`/api/transport/driver/${bus.driverToken}`)).status).toBe(200);
    await setSub(A.school, { plan: 'standard' });
    expect((await api().get(`/api/transport/driver/${bus.driverToken}`)).status).toBe(403);
  });

  test('fee reminders are only sent for schools that have the fees module', async () => {
    const due = new Date(Date.now() + 2 * DAY);
    await Fee.create({ school: A.school._id, studentId: A.student._id, feeType: 'Tuition', amount: 1000, dueDate: due, status: 'Unpaid' });
    await setSub(A.school, { plan: 'basic' });
    expect(await sendFeeReminders()).toBe(0);
    await setSub(A.school, { plan: 'standard' });
    expect(await sendFeeReminders()).toBe(1);
  });
});

describe('billing state', () => {
  test('after the trial ends the school keeps full access during the grace period, then becomes read-only', async () => {
    await setSub(A.school, { status: 'trial', trialEndsAt: new Date(Date.now() - 2 * DAY), graceDays: 7 });
    let profile = await api().get('/api/users/profile').set(auth(A.admin));
    expect(profile.body.data.subscription.status).toBe('past_due');
    expect((await api().post('/api/announcements').set(auth(A.admin)).send({ title: 'Hi', message: 'Hello' })).status).not.toBe(403);

    await setSub(A.school, { trialEndsAt: new Date(Date.now() - 10 * DAY) });
    profile = await api().get('/api/users/profile').set(auth(A.admin));
    expect(profile.body.data.subscription.status).toBe('read_only');
    expect((await api().get('/api/students').set(auth(A.admin))).status).toBe(200);
    const write = await api().post('/api/announcements').set(auth(A.admin)).send({ title: 'Hi', message: 'Hello' });
    expect(write.status).toBe(403);
    expect(write.body.code).toBe('READ_ONLY');
    // Account security still works.
    const pw = await api().patch('/api/users/password').set(auth(A.admin)).send({ currentPassword: 'Password123', newPassword: 'NewPassword456' });
    expect(pw.status).toBe(200);
  });

  test('a paid school with no end date is active; suspended schools cannot sign in or use old tokens', async () => {
    await setSub(A.school, { status: 'active', currentPeriodEnd: null });
    expect((await api().get('/api/users/profile').set(auth(A.admin))).body.data.subscription.status).toBe('active');

    await setSub(A.school, { status: 'suspended' });
    const login = await api().post('/api/users/login').send({ email: A.admin.email, password: 'Password123' });
    expect(login.status).toBe(403);
    expect(login.body.code).toBe('SCHOOL_SUSPENDED');
    const me = await api().get('/api/users/profile').set(auth(A.admin));
    expect(me.status).toBe(403);
    expect(me.body.code).toBe('SCHOOL_SUSPENDED');
  });
});

describe('platform owner API', () => {
  test('platform and school tokens cannot be used on each other\'s APIs; owners cannot use the school login', async () => {
    const { user, headers } = await makePlatformAdmin();
    expect((await api().get('/api/platform/me').set(headers)).status).toBe(200);
    expect((await api().get('/api/platform/me').set(auth(A.admin))).status).toBe(403);
    expect((await api().get('/api/users/profile').set(headers)).status).toBe(401);
    expect((await api().post('/api/users/login').send({ email: user.email, password: 'OwnerPass123' })).status).toBe(401);
    expect((await api().get('/api/platform/schools')).status).toBe(401);
  });

  test('onboard a school with a plan; its admin can sign in and sees that plan', async () => {
    const { headers } = await makePlatformAdmin();
    const res = await api().post('/api/platform/schools').set(headers).send({
      name: 'Green Valley Public School', city: 'Jaipur', adminName: 'Priya', adminEmail: 'Priya@GV.edu.in',
      plan: 'standard', addOns: ['transport'], trialDays: 14,
    });
    expect(res.status).toBe(201);
    expect(res.body.data.code).toBe('GVPS');
    expect(res.body.data.state.status).toBe('trial');
    expect(res.body.data.features).toEqual(['admissions', 'chat', 'exams', 'fees', 'transport']);

    const login = await api().post('/api/users/login').send({ email: 'priya@gv.edu.in', password: res.body.credentials.password });
    expect(login.status).toBe(200);
    expect(login.body.user.mustChangePassword).toBe(true);
    expect(login.body.user.plan.code).toBe('standard');

    const dup = await api().post('/api/platform/schools').set(headers).send({ name: 'X', adminName: 'Y', adminEmail: 'priya@gv.edu.in' });
    expect(dup.status).toBe(409);
    expect(await School.countDocuments({ name: 'X' })).toBe(0);
  });

  test('change plan, add-ons and dates; changes take effect at once and are audited', async () => {
    const { headers } = await makePlatformAdmin();
    const bad = await api().patch(`/api/platform/schools/${A.school._id}/subscription`).set(headers).send({ addOns: ['teleport'] });
    expect(bad.status).toBe(400);

    const res = await api().patch(`/api/platform/schools/${A.school._id}/subscription`).set(headers).send({
      plan: 'basic', addOns: ['library'], status: 'active', currentPeriodEnd: new Date(Date.now() + 365 * DAY).toISOString(),
    });
    expect(res.status).toBe(200);
    expect(res.body.data.features).toEqual(['library']);
    expect(res.body.data.state.status).toBe('active');
    expect((await api().get('/api/fees').set(auth(A.admin))).status).toBe(403);
    expect((await api().get('/api/library').set(auth(A.admin))).status).toBe(200);
    expect(await AuditLog.countDocuments({ action: 'platform.subscription_updated', school: A.school._id })).toBe(1);
  });

  test('plans and prices are edited from the API and used by schools', async () => {
    const { headers } = await makePlatformAdmin();
    const saved = await api().put('/api/platform/plans/starter').set(headers).send({
      name: 'Starter', features: ['fees'], limits: { maxStudents: 300 }, pricePerStudentYear: 250,
    });
    expect(saved.status).toBe(200);
    await api().put('/api/platform/addons/transport').set(headers).send({ pricePerStudentYear: 60 });
    const catalog = await api().get('/api/platform/catalog').set(headers);
    expect(catalog.body.data.plans.find((p) => p.code === 'starter').pricePerStudentYear).toBe(250);
    expect(catalog.body.data.addOns.find((a) => a.feature === 'transport').pricePerStudentYear).toBe(60);

    await api().patch(`/api/platform/schools/${A.school._id}/subscription`).set(headers).send({ plan: 'starter' });
    const profile = await api().get('/api/users/profile').set(auth(A.admin));
    expect(profile.body.data.features).toEqual(['fees']);
  });

  test('school list shows state and usage; stats count schools by state', async () => {
    const { headers } = await makePlatformAdmin();
    await seedSchool('Beta School');
    await setSub(A.school, { status: 'suspended' });
    const list = await api().get('/api/platform/schools').set(headers);
    expect(list.status).toBe(200);
    expect(list.body.pagination.total).toBe(2);
    const alpha = list.body.data.find((s) => s.code === 'ALP');
    expect(alpha.usage.activeStudents).toBe(2);
    expect(alpha.usage.users.teacher).toBe(1);
    const suspended = await api().get('/api/platform/schools?state=suspended').set(headers);
    expect(suspended.body.data.map((s) => s.code)).toEqual(['ALP']);
    const stats = await api().get('/api/platform/stats').set(headers);
    expect(stats.body.data.byState).toEqual({ suspended: 1, trial: 1 });
  });

  test('support session: needs a reason, acts as the school admin for an hour, and every change is audited', async () => {
    const { user, headers } = await makePlatformAdmin();
    expect((await api().post(`/api/platform/schools/${A.school._id}/support-session`).set(headers).send({})).status).toBe(400);
    const res = await api().post(`/api/platform/schools/${A.school._id}/support-session`).set(headers).send({ reason: 'Fee report looks wrong' });
    expect(res.status).toBe(200);
    expect(res.body.actingAs.email).toBe(A.admin.email);
    const support = { Authorization: `Bearer ${res.body.token}` };
    expect(jwt.decode(res.body.token).imp).toBe(String(user._id));

    expect((await api().get('/api/students').set(support)).status).toBe(200);
    await api().post('/api/announcements').set(support).send({ title: 'Test', message: 'From support' });
    await new Promise((r) => setTimeout(r, 50));
    const writes = await AuditLog.find({ action: 'support.write', school: A.school._id });
    expect(writes).toHaveLength(1);
    expect(String(writes[0].impersonatedBy)).toBe(String(user._id));

    const log = await api().get(`/api/platform/audit?school=${A.school._id}`).set(headers);
    expect(log.body.data.map((r) => r.action)).toEqual(expect.arrayContaining(['support.session_started', 'support.write']));
  });

  test('platform can set the code, domain and branding; codes stay unique', async () => {
    const { headers } = await makePlatformAdmin();
    const B = await seedSchool('Beta School');
    const res = await api().patch(`/api/platform/schools/${A.school._id}`).set(headers).send({
      code: 'alpha1', customDomain: 'ERP.Alpha.edu.in', branding: { appName: 'Alpha Connect', primaryColor: '#0A7E8C' },
    });
    expect(res.status).toBe(200);
    expect(res.body.data.code).toBe('ALPHA1');
    expect(res.body.data.customDomain).toBe('erp.alpha.edu.in');
    const clash = await api().patch(`/api/platform/schools/${B.school._id}`).set(headers).send({ code: 'ALPHA1' });
    expect(clash.status).toBe(409);
    const badColour = await api().patch(`/api/platform/schools/${B.school._id}`).set(headers).send({ branding: { primaryColor: 'blue' } });
    expect(badColour.status).toBe(400);
  });
});

describe('school branding (school admin)', () => {
  test('admin updates app name, colour and tagline; teachers cannot', async () => {
    const res = await api().put('/api/schools/me/branding').set(auth(A.admin)).send({ appName: 'Alpha Connect', primaryColor: '#0A7E8C', accentColor: '#F2B705', tagline: 'Learn and grow', heroStyle: 'light' });
    expect(res.status).toBe(200);
    expect(res.body.data.branding).toEqual({ appName: 'Alpha Connect', logoUrl: '', primaryColor: '#0A7E8C', accentColor: '#F2B705', tagline: 'Learn and grow', heroStyle: 'light' });
    expect((await api().put('/api/schools/me/branding').set(auth(A.admin)).send({ accentColor: 'gold' })).status).toBe(400);
    expect((await api().put('/api/schools/me/branding').set(auth(A.admin)).send({ heroStyle: 'neon' })).status).toBe(400);
    const login = await api().post('/api/users/login').send({ email: A.admin.email, password: 'Password123' });
    expect(login.body.user.branding.accentColor).toBe('#F2B705');
    expect(login.body.user.branding.heroStyle).toBe('light');
    expect(res.body.data.code).toBe('ALP');
    expect(res.body.data.plan.code).toBe('premium');
    expect((await api().put('/api/schools/me/branding').set(auth(A.teacherUser)).send({ appName: 'X' })).status).toBe(403);
  });
});

describe('migration', () => {
  test('existing schools get a code and keep every feature; a second run changes nothing', async () => {
    const legacy = await School.collection.insertOne({ name: 'Old Public School', isActive: true });
    await makeUser({ _id: legacy.insertedId }, 'admin');
    await migrate({ apply: true, quiet: true });
    const school = await School.findById(legacy.insertedId);
    expect(school.code).toBe('OPS');
    expect(school.subscription.plan).toBe('premium');
    expect(school.subscription.status).toBe('active');
    const again = await migrate({ apply: true, quiet: true });
    expect(again['schools.code_or_subscription_set']).toBeUndefined();
  });
});
