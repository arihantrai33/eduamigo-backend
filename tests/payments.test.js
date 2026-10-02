const { api, connect, disconnect, clear, auth, seedSchool, makeUser } = require('./helpers');
const Fee = require('../src/models/Fee');
const School = require('../src/models/School');
const PaymentOrder = require('../src/models/PaymentOrder');
const Notification = require('../src/models/Notification');
const gateway = require('../src/services/razorpay');
const { recordPayment } = require('../src/services/feeService');

const KEY_ID = 'rzp_test_AbC123';
const KEY_SECRET = 'test_secret_value';
const WEBHOOK_SECRET = 'whsec_value';
let A;
let B;
let fee;
let orderSeq = 0;
// Concurrency guarantees come from MongoDB's atomic single-document updates. The FerretDB stand-in used in
// some sandboxes (MONGO_TEST_URI) does not provide them, so these run only on real MongoDB (the default).
const realMongoTest = process.env.TEST_DB_IS_REAL_MONGO === 'true' ? test : test.skip;

beforeAll(connect);
afterAll(disconnect);
beforeEach(async () => {
  await clear();
  A = await seedSchool('Alpha School');
  B = await seedSchool('Beta School');
  fee = await Fee.create({ school: A.school._id, studentId: A.student._id, feeType: 'Tuition', amount: 5000, dueDate: new Date(), academicYear: '2026-27' });
  gateway.setTransport(async (url, init) => {
    const body = JSON.parse(init.body);
    orderSeq += 1;
    return { ok: true, status: 200, json: async () => ({ id: `order_${orderSeq}`, amount: body.amount, currency: 'INR', status: 'created' }) };
  });
});

async function enablePayments(ctx = A) {
  await api().put('/api/payments/settings').set(auth(ctx.admin))
    .send({ enabled: true, keyId: KEY_ID, keySecret: KEY_SECRET, webhookSecret: WEBHOOK_SECRET }).expect(200);
}
const sign = (orderId, paymentId) => gateway.hmac(KEY_SECRET, `${orderId}|${paymentId}`);
const webhookBody = (orderId, paymentId, amount) => JSON.stringify({
  event: 'payment.captured', payload: { payment: { entity: { id: paymentId, order_id: orderId, amount, status: 'captured' } } },
});
const sendWebhook = (schoolId, body, secret = WEBHOOK_SECRET) => api().post(`/api/payments/webhook/${schoolId}`)
  .set('Content-Type', 'application/json').set('X-Razorpay-Signature', gateway.hmac(secret, body)).send(body);

test('settings: secrets are stored encrypted and never returned; only admins can change them', async () => {
  await api().put('/api/payments/settings').set(auth(A.parentUser)).send({ enabled: true }).expect(403);
  await api().put('/api/payments/settings').set(auth(A.admin)).send({ enabled: true }).expect(400);
  await api().put('/api/payments/settings').set(auth(A.admin)).send({ keyId: 'not-a-key' }).expect(400);
  await enablePayments();
  const stored = await School.findById(A.school._id);
  expect(stored.payments.keySecretEnc).not.toContain(KEY_SECRET);
  const res = await api().get('/api/payments/settings').set(auth(A.admin));
  expect(JSON.stringify(res.body)).not.toContain(KEY_SECRET);
  expect(res.body.data).toMatchObject({ enabled: true, keyId: KEY_ID, hasKeySecret: true, hasWebhookSecret: true });
});

test('ordering when the school has not enabled payments gives a clear message', async () => {
  const res = await api().post('/api/payments/orders').set(auth(A.parentUser)).send({ feeId: String(fee._id) });
  expect(res.status).toBe(503);
  expect(res.body.message).toMatch(/not set up online payments/);
  const cfg = await api().get('/api/payments/config').set(auth(A.parentUser));
  expect(cfg.body.data).toEqual({ enabled: false, provider: 'razorpay', keyId: null });
});

test('parent pays the balance: order, verified signature, receipt, fee updated, parent notified', async () => {
  await enablePayments();
  const order = await api().post('/api/payments/orders').set(auth(A.parentUser)).send({ feeId: String(fee._id) }).expect(201);
  expect(order.body.data).toMatchObject({ keyId: KEY_ID, amount: 500000, currency: 'INR' });
  const { orderId } = order.body.data;

  const bad = await api().post('/api/payments/verify').set(auth(A.parentUser))
    .send({ razorpay_order_id: orderId, razorpay_payment_id: 'pay_1', razorpay_signature: 'forged' });
  expect(bad.status).toBe(400);

  const ok = await api().post('/api/payments/verify').set(auth(A.parentUser))
    .send({ razorpay_order_id: orderId, razorpay_payment_id: 'pay_1', razorpay_signature: sign(orderId, 'pay_1') }).expect(200);
  expect(ok.body.data.status).toBe('paid');
  expect(ok.body.data.receiptNo).toMatch(/^RCPT-/);

  const updated = await Fee.findById(fee._id);
  expect(updated).toMatchObject({ paidAmount: 5000, status: 'Paid' });
  expect(updated.payments[0]).toMatchObject({ mode: 'Online', reference: 'Razorpay pay_1' });
  expect(await Notification.countDocuments({ recipient: A.parentUser._id, title: 'Fee payment received' })).toBe(1);

  const receipt = await api().get(`/api/fees/${fee._id}/receipts/${ok.body.data.receiptNo}`).set(auth(A.parentUser)).expect(200);
  expect(receipt.body.data).toMatchObject({ balanceAfter: 0, paidToDate: 5000, payment: { amount: 5000, mode: 'Online' } });
  await api().get(`/api/fees/${fee._id}/receipts/${ok.body.data.receiptNo}`).set(auth(B.parentUser)).expect(404);
});

realMongoTest('browser confirmation and webhook together apply the payment exactly once', async () => {
  await enablePayments();
  const { body } = await api().post('/api/payments/orders').set(auth(A.parentUser)).send({ feeId: String(fee._id), amount: 2000 }).expect(201);
  const { orderId } = body.data;
  const hook = webhookBody(orderId, 'pay_9', 200000);
  await Promise.all([
    sendWebhook(A.school._id, hook),
    api().post('/api/payments/verify').set(auth(A.parentUser)).send({ razorpay_order_id: orderId, razorpay_payment_id: 'pay_9', razorpay_signature: sign(orderId, 'pay_9') }),
    sendWebhook(A.school._id, hook),
  ]);
  const updated = await Fee.findById(fee._id);
  expect(updated.payments).toHaveLength(1);
  expect(updated).toMatchObject({ paidAmount: 2000, status: 'Partial' });
  expect((await PaymentOrder.findOne({ providerOrderId: orderId })).status).toBe('paid');
  expect(await Notification.countDocuments({ recipient: A.parentUser._id, title: 'Fee payment received' })).toBe(1);
});

test('the same order reported twice in a row is applied once', async () => {
  await enablePayments();
  const { body } = await api().post('/api/payments/orders').set(auth(A.parentUser)).send({ feeId: String(fee._id), amount: 1500 }).expect(201);
  const { orderId } = body.data;
  await sendWebhook(A.school._id, webhookBody(orderId, 'pay_s', 150000)).expect(200);
  const again = await api().post('/api/payments/verify').set(auth(A.parentUser))
    .send({ razorpay_order_id: orderId, razorpay_payment_id: 'pay_s', razorpay_signature: sign(orderId, 'pay_s') }).expect(200);
  expect(again.body.data.status).toBe('paid');
  await sendWebhook(A.school._id, webhookBody(orderId, 'pay_s', 150000)).expect(200);
  const updated = await Fee.findById(fee._id);
  expect(updated.payments).toHaveLength(1);
  expect(updated.paidAmount).toBe(1500);
  expect(await Notification.countDocuments({ recipient: A.parentUser._id, title: 'Fee payment received' })).toBe(1);
});

test('webhook with a wrong signature or for another school is ignored', async () => {
  await enablePayments();
  const { body } = await api().post('/api/payments/orders').set(auth(A.parentUser)).send({ feeId: String(fee._id) }).expect(201);
  const hook = webhookBody(body.data.orderId, 'pay_x', 500000);
  await sendWebhook(A.school._id, hook, 'wrong-secret').expect(400);
  await enablePayments(B);
  await sendWebhook(B.school._id, hook).expect(200); // valid for B, but the order belongs to A
  expect((await Fee.findById(fee._id)).paidAmount).toBe(0);
});

test('money that arrives after the fee was cleared in cash is flagged for the office, not lost', async () => {
  await enablePayments();
  const { body } = await api().post('/api/payments/orders').set(auth(A.parentUser)).send({ feeId: String(fee._id) }).expect(201);
  await recordPayment({ school: A.school._id, feeId: fee._id, mode: 'Cash' });
  const res = await api().post('/api/payments/verify').set(auth(A.parentUser))
    .send({ razorpay_order_id: body.data.orderId, razorpay_payment_id: 'pay_late', razorpay_signature: sign(body.data.orderId, 'pay_late') });
  expect(res.body.data.status).toBe('needs_review');
  expect(await Notification.countDocuments({ recipient: A.admin._id, title: 'Online payment needs review' })).toBe(1);
  const list = await api().get('/api/payments/orders?status=needs_review').set(auth(A.admin));
  expect(list.body.data).toHaveLength(1);
});

realMongoTest('two payments at the same moment never take a fee past its total', async () => {
  const results = await Promise.allSettled([
    recordPayment({ school: A.school._id, feeId: fee._id, amount: 3000, mode: 'Cash' }),
    recordPayment({ school: A.school._id, feeId: fee._id, amount: 3000, mode: 'UPI' }),
  ]);
  const updated = await Fee.findById(fee._id);
  expect(updated.paidAmount).toBeLessThanOrEqual(5000);
  expect(updated.payments.reduce((s, p) => s + p.amount, 0)).toBe(updated.paidAmount);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
});

test('limits: amount above balance, other families, other schools', async () => {
  await enablePayments();
  await api().post('/api/payments/orders').set(auth(A.parentUser)).send({ feeId: String(fee._id), amount: 6000 }).expect(400);
  await api().post('/api/payments/orders').set(auth(A.parentUser)).send({ feeId: String(fee._id), amount: 0.5 }).expect(400);
  const stranger = await makeUser(A.school, 'parent');
  await api().post('/api/payments/orders').set(auth(stranger)).send({ feeId: String(fee._id) }).expect(404);
  await api().post('/api/payments/orders').set(auth(B.parentUser)).send({ feeId: String(fee._id) }).expect(404);
  await api().post('/api/payments/orders').set(auth(A.admin)).send({ feeId: String(fee._id) }).expect(403);
  const s = await api().post('/api/payments/orders').set(auth(A.studentUser)).send({ feeId: String(fee._id) });
  expect(s.status).toBe(201);
});

test('a refused gateway order is reported without leaking details', async () => {
  await enablePayments();
  gateway.setTransport(async () => ({ ok: false, status: 401, json: async () => ({ error: { description: 'Authentication failed' } }) }));
  const res = await api().post('/api/payments/orders').set(auth(A.parentUser)).send({ feeId: String(fee._id) });
  expect(res.status).toBe(503);
  expect(res.body.message).toMatch(/not available right now/);
  expect(res.body.message).not.toMatch(/Authentication/);
  expect((await PaymentOrder.findOne({})).status).toBe('failed');
});
