const { api, connect, disconnect, clear, auth, seedSchool } = require('./helpers');
const AuditLog = require('../src/models/AuditLog');
const Fee = require('../src/models/Fee');
const { sanitize } = require('../src/middleware/auditTrail');

let A;
let B;
let fee;

beforeAll(connect);
afterAll(disconnect);
beforeEach(async () => {
  await clear();
  A = await seedSchool('Alpha School');
  B = await seedSchool('Beta School');
  fee = await Fee.create({ school: A.school._id, studentId: A.student._id, feeType: 'Tuition', amount: 5000, dueDate: new Date(), academicYear: '2026-27' });
});

// Entries are written after the response is sent.
async function waitForLog(filter, n = 1) {
  for (let i = 0; i < 40; i += 1) {
    const rows = await AuditLog.find(filter).lean();
    if (rows.length >= n) return rows;
    await new Promise((r) => setTimeout(r, 25));
  }
  return AuditLog.find(filter).lean();
}

test('a fee collection is recorded with who, which fee and the amount', async () => {
  await api().patch(`/api/fees/${fee._id}/pay`).set(auth(A.admin)).send({ amount: 2000, paymentMode: 'Cash' }).expect(200);
  const [row] = await waitForLog({ action: 'fee.payment_recorded' });
  expect(String(row.school)).toBe(String(A.school._id));
  expect(String(row.actor)).toBe(String(A.admin._id));
  expect(row.actorRole).toBe('admin');
  expect(row.targetId).toBe(String(fee._id));
  expect(row.details.body.amount).toBe(2000);
});

test('failed changes are not recorded', async () => {
  await api().patch(`/api/fees/${fee._id}/pay`).set(auth(A.admin)).send({ amount: 999999 }).expect(400);
  await new Promise((r) => setTimeout(r, 150));
  expect(await AuditLog.countDocuments({ action: 'fee.payment_recorded' })).toBe(0);
});

test('secrets in a request are never stored', async () => {
  await api().put('/api/payments/settings').set(auth(A.admin))
    .send({ enabled: false, keyId: 'rzp_test_AbC123', keySecret: 'super-secret', webhookSecret: 'whsec' }).expect(200);
  const [row] = await waitForLog({ action: 'payments.settings_changed' });
  expect(row.details.body.keySecret).toBe('[hidden]');
  expect(row.details.body.webhookSecret).toBe('[hidden]');
  expect(JSON.stringify(row)).not.toContain('super-secret');
  expect(sanitize({ password: 'x', nested: { otp: '1', ok: 'y' } })).toEqual({ password: '[hidden]', nested: { otp: '[hidden]', ok: 'y' } });
});

test('admins read their own school\'s activity, filtered; others cannot', async () => {
  await api().patch(`/api/fees/${fee._id}/pay`).set(auth(A.admin)).send({ amount: 1000, paymentMode: 'Cash' }).expect(200);
  await api().post('/api/academic/sessions').set(auth(A.admin)).send({ name: '2026-27' }).expect(201);
  await api().post('/api/academic/sessions').set(auth(B.admin)).send({ name: '2026-27' }).expect(201);
  await waitForLog({}, 3);

  const all = await api().get('/api/audit').set(auth(A.admin));
  expect(all.status).toBe(200);
  expect(all.body.pagination.total).toBe(2);
  expect(all.body.data[0].actor.name).toBe(A.admin.name);
  const fees = await api().get('/api/audit?action=fee.').set(auth(A.admin));
  expect(fees.body.data.map((r) => r.action)).toEqual(['fee.payment_recorded']);
  expect((await api().get('/api/audit').set(auth(A.teacherUser))).status).toBe(403);
  expect((await api().get('/api/audit?from=not-a-date').set(auth(A.admin))).status).toBe(400);
});
