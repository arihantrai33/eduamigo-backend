// Owner console operations: analytics, platform accounts, announcements, support requests, settings.
const { api, connect, disconnect, clear, auth, seedSchool } = require('./helpers');
const User = require('../src/models/User');
const Invoice = require('../src/models/Invoice');
const SupportRequest = require('../src/models/SupportRequest');
const AuditLog = require('../src/models/AuditLog');
const jwt = require('jsonwebtoken');
const { hashPassword } = require('../src/services/credentials');

let A; let B; let owner; let token;
const H = () => ({ Authorization: `Bearer ${token}` });
beforeAll(connect); afterAll(disconnect);
beforeEach(async () => {
  await clear();
  A = await seedSchool('Alpha'); B = await seedSchool('Beta');
  owner = await User.create({ name: 'Owner', email: `o${Date.now()}@e.test`, password: await hashPassword('OwnerPass123'), role: 'superadmin' });
  token = (await api().post('/api/platform/login').send({ email: owner.email, password: 'OwnerPass123' })).body.token;
});

test('only the platform owner reaches the operations routes', async () => {
  for (const [m, p] of [['get', '/api/platform/analytics'], ['get', '/api/platform/users'], ['post', '/api/platform/users'], ['get', '/api/platform/notices'], ['get', '/api/platform/support'], ['put', '/api/platform/settings']]) {
    expect((await api()[m](p)).status).toBe(401);
    expect((await api()[m](p).set(auth(A.admin))).status).toBe(403);
  }
});

describe('analytics', () => {
  test('counts are real: schools, paid revenue by month, and what needs attention', async () => {
    await Invoice.create({ number: 'INV-1', school: A.school._id, periodFrom: new Date(), periodTo: new Date(), subtotal: 100, tax: 18, total: 118, status: 'paid', paidAt: new Date() });
    await Invoice.create({ number: 'INV-2', school: A.school._id, periodFrom: new Date(), periodTo: new Date(), subtotal: 100, tax: 18, total: 118, status: 'issued', dueDate: new Date(Date.now() - 86400000) });
    await SupportRequest.create({ school: A.school._id, createdBy: A.admin._id, subject: 'Help', notes: [{ by: 'school', text: 'please' }] });
    const r = (await api().get('/api/platform/analytics?months=6').set(H())).body.data;
    expect(r.months).toHaveLength(6);
    expect(r.schoolsAdded.reduce((a, b) => a + b, 0)).toBe(2);
    expect(r.revenuePaid[5]).toBe(118);
    expect(r.totals.outstanding).toBe(118);
    expect(r.attention.overdueInvoices).toHaveLength(1);
    expect(r.attention.openSupportRequests).toBe(1);
  });
});

describe('platform accounts', () => {
  test('create with a strong password, reject weak or duplicate, never return a password', async () => {
    const post = (b) => api().post('/api/platform/users').set(H()).send(b);
    expect((await post({ name: 'Ravi', email: 'ravi@eduamigo.test', password: 'short' })).status).toBe(400);
    expect((await post({ name: 'Ravi', email: 'bad', password: 'Strong#1234' })).status).toBe(400);
    const ok = await post({ name: 'Ravi', email: 'ravi@eduamigo.test', password: 'Strong#1234' });
    expect(ok.status).toBe(201);
    expect(JSON.stringify(ok.body)).not.toMatch(/Strong#1234|password/i);
    expect((await post({ name: 'Ravi', email: 'ravi@eduamigo.test', password: 'Strong#1234' })).status).toBe(409);
    expect((await post({ name: 'Xavier', email: A.admin.email, password: 'Strong#1234' })).status).toBe(409); // school emails are taken too
    expect((await api().post('/api/platform/login').send({ email: 'ravi@eduamigo.test', password: 'Strong#1234' })).status).toBe(200);
  });

  test('last-owner and self protections; switching someone off signs them out everywhere', async () => {
    const other = (await api().post('/api/platform/users').set(H()).send({ name: 'Ravi', email: 'ravi@eduamigo.test', password: 'Strong#1234' })).body.data;
    const otherToken = (await api().post('/api/platform/login').send({ email: 'ravi@eduamigo.test', password: 'Strong#1234' })).body.token;
    expect((await api().patch(`/api/platform/users/${owner._id}`).set(H()).send({ isActive: false })).status).toBe(400); // yourself
    expect((await api().patch(`/api/platform/users/${other._id}`).set(H()).send({ isActive: false })).status).toBe(200);
    expect((await api().get('/api/platform/me').set({ Authorization: `Bearer ${otherToken}` })).status).toBe(401);
    // the remaining owner cannot be switched off by the (now inactive) other: inactive accounts cannot act at all
    expect((await api().patch(`/api/platform/users/${other._id}`).set({ Authorization: `Bearer ${otherToken}` }).send({ isActive: true })).status).toBe(401);
    const only = await User.findById(other._id); only.isActive = true; await only.save();
    await User.updateOne({ _id: owner._id }, { isActive: false });
    expect((await api().patch(`/api/platform/users/${owner._id}`).set(H()).send({ isActive: true })).status).toBe(401);
  });

  test('a password reset signs the person out and audits without the password', async () => {
    const other = (await api().post('/api/platform/users').set(H()).send({ name: 'Ravi', email: 'ravi@eduamigo.test', password: 'Strong#1234' })).body.data;
    const t = (await api().post('/api/platform/login').send({ email: 'ravi@eduamigo.test', password: 'Strong#1234' })).body.token;
    expect((await api().post(`/api/platform/users/${other._id}/reset-password`).set(H()).send({ password: 'weak' })).status).toBe(400);
    expect((await api().post(`/api/platform/users/${other._id}/reset-password`).set(H()).send({ password: 'Newer#98765' })).status).toBe(200);
    expect((await api().get('/api/platform/me').set({ Authorization: `Bearer ${t}` })).status).toBe(401);
    expect((await api().post('/api/platform/login').send({ email: 'ravi@eduamigo.test', password: 'Newer#98765' })).status).toBe(200);
    expect(JSON.stringify(await AuditLog.find({}).lean())).not.toMatch(/Newer#98765|Strong#1234/);
  });

  test('a school administrator cannot become or reach a platform account', async () => {
    expect((await api().post('/api/platform/users').set(auth(A.admin)).send({ name: 'X', email: 'x@y.test', password: 'Strong#1234' })).status).toBe(403);
    const forged = jwt.sign({ id: A.admin._id, role: 'superadmin', scope: 'platform' }, process.env.JWT_SECRET, { expiresIn: '1h' });
    expect((await api().get('/api/platform/users').set({ Authorization: `Bearer ${forged}` })).status).toBe(401);
  });
});

describe('announcements', () => {
  test('a live announcement reaches school offices only; scheduled, ended and archived ones do not', async () => {
    const post = (b) => api().post('/api/platform/notices').set(H()).send(b);
    expect((await post({ title: 'x', message: 'short' })).status).toBe(400);
    expect((await post({ title: 'Maintenance', message: 'Sunday 2am', level: 'urgent' })).status).toBe(400);
    expect((await post({ title: 'Maintenance', message: 'Sunday 2am', startsAt: '2026-01-02', endsAt: '2026-01-01' })).status).toBe(400);
    const live = (await post({ title: 'Maintenance', message: 'Sunday at 2am for ten minutes', level: 'warning' })).body.data;
    await post({ title: 'Later', message: 'Not yet visible', startsAt: new Date(Date.now() + 86400000 * 5).toISOString() });
    await post({ title: 'Over', message: 'Already finished', startsAt: '2026-01-01', endsAt: '2026-01-02' });
    const shown = (await api().get('/api/support/notices').set(auth(A.admin))).body.data;
    expect(shown.map((n) => n.title)).toEqual(['Maintenance']);
    expect((await api().get('/api/support/notices').set(auth(B.admin))).body.data).toHaveLength(1);
    expect((await api().get('/api/support/notices').set(auth(A.teacherUser))).status).toBe(403);
    expect((await api().get('/api/support/notices').set(auth(A.parentUser))).status).toBe(403);
    await api().post(`/api/platform/notices/${live._id}/archive`).set(H());
    expect((await api().get('/api/support/notices').set(auth(A.admin))).body.data).toHaveLength(0);
    const list = (await api().get('/api/platform/notices').set(H())).body.data.map((n) => n.state).sort();
    expect(list).toEqual(['archived', 'ended', 'scheduled']);
  });
});

describe('support requests', () => {
  const create = (who, body) => api().post('/api/support/requests').set(auth(who)).send(body);
  test('a school opens a request, the owner replies publicly and privately, the school sees only the public reply', async () => {
    expect((await create(A.admin, { subject: 'a', message: 'b' })).status).toBe(400);
    const made = await create(A.admin, { subject: 'Fee receipts not printing', message: 'The receipt page is blank for Class 5.', category: 'technical' });
    expect(made.status).toBe(201);
    const id = made.body.data._id;
    await api().patch(`/api/platform/support/${id}`).set(H()).send({ note: 'Looks like the print template.', internal: true, status: 'in_progress', priority: 'high', assignToMe: true });
    await api().patch(`/api/platform/support/${id}`).set(H()).send({ note: 'We are looking into it and will update you today.' });
    const mine = (await api().get('/api/support/requests').set(auth(A.admin))).body.data[0];
    expect(mine.status).toBe('in_progress');
    expect(mine.messages.map((m) => m.text)).toEqual(['The receipt page is blank for Class 5.', 'We are looking into it and will update you today.']);
    expect(JSON.stringify(mine)).not.toContain('print template');
    expect(mine.messages[1].author).toBe('EduAmigo support');
    const detail = (await api().get(`/api/platform/support/${id}`).set(H())).body.data;
    expect(detail.notes).toHaveLength(3);
    await api().patch(`/api/platform/support/${id}`).set(H()).send({ status: 'resolved' });
    const reopened = await api().post(`/api/support/requests/${id}/reply`).set(auth(A.admin)).send({ message: 'It is still blank.' });
    expect(reopened.body.data.status).toBe('open');
  });

  test('schools cannot see or answer each other\'s requests; non-admin roles cannot write', async () => {
    const id = (await create(A.admin, { subject: 'Alpha only', message: 'Private to Alpha school.' })).body.data._id;
    expect((await api().get('/api/support/requests').set(auth(B.admin))).body.data).toHaveLength(0);
    expect((await api().post(`/api/support/requests/${id}/reply`).set(auth(B.admin)).send({ message: 'Hello from Beta' })).status).toBe(404);
    expect((await create(A.teacherUser, { subject: 'Teacher asks', message: 'Teachers may not open requests.' })).status).toBe(403);
    expect((await api().get('/api/platform/support').set(H())).body.data).toHaveLength(1);
  });

  test('the owner list filters by status and counts them', async () => {
    await create(A.admin, { subject: 'One request', message: 'First request body.' });
    const id = (await create(B.admin, { subject: 'Two request', message: 'Second request body.' })).body.data._id;
    await api().patch(`/api/platform/support/${id}`).set(H()).send({ status: 'resolved' });
    const open = await api().get('/api/platform/support?status=open').set(H());
    expect(open.body.data).toHaveLength(1);
    expect(open.body.counts).toEqual({ open: 1, resolved: 1 });
    expect((await api().patch(`/api/platform/support/${id}`).set(H()).send({ status: 'closed' })).status).toBe(400);
  });
});

describe('settings', () => {
  test('validated, saved, and the session length is used for the next sign-in', async () => {
    const put = (b) => api().put('/api/platform/settings').set(H()).send(b);
    expect((await put({ sessionHours: 99 })).status).toBe(400);
    expect((await put({ supportEmail: 'nope' })).status).toBe(400);
    expect((await put({ orgName: 'E' })).status).toBe(400);
    const ok = await put({ orgName: 'EduAmigo Pvt Ltd', supportEmail: 'help@eduamigo.test', sessionHours: 2 });
    expect(ok.body.data).toMatchObject({ orgName: 'EduAmigo Pvt Ltd', sessionHours: 2 });
    const t = (await api().post('/api/platform/login').send({ email: owner.email, password: 'OwnerPass123' })).body.token;
    const d = jwt.decode(t);
    expect(d.exp - d.iat).toBe(2 * 3600);
  });
});
