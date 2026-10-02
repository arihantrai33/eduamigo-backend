// Online fee payments through each school's own Razorpay account.
//   1. Parent/student asks for an order for one fee (POST /orders).
//   2. Razorpay Checkout collects the money in the browser.
//   3. The browser sends the signed result (POST /verify) and Razorpay also calls the webhook.
// Whichever of 3 arrives first applies the payment; the other finds it already done.
const Fee = require('../models/Fee');
const School = require('../models/School');
const Student = require('../models/Student');
const User = require('../models/User');
const PaymentOrder = require('../models/PaymentOrder');
const { HttpError, asyncHandler, assertId } = require('../utils/http');
const { canAccessStudent } = require('../services/directory');
const { recordPayment } = require('../services/feeService');
const { notifyParents, notifyUser } = require('../services/notify');
const { encrypt, decrypt } = require('../services/secrets');
const gateway = require('../services/razorpay');

const unavailable = (detail) => Object.assign(
  new HttpError(503, `Online payment is not available right now. ${detail || 'Please try again later or pay at the school office.'}`),
  { expose: true },
);

async function gatewayFor(schoolId) {
  const school = await School.findById(schoolId).select('name payments');
  const p = school?.payments;
  if (!p?.enabled || !p.keyId || !p.keySecretEnc) return { school, enabled: false };
  return { school, enabled: true, keyId: p.keyId, keySecret: decrypt(p.keySecretEnc), webhookSecret: decrypt(p.webhookSecretEnc) };
}

// ---------- Settings (admin) ----------

// GET /api/payments/settings
exports.getSettings = asyncHandler(async (req, res) => {
  const school = await School.findById(req.schoolId).select('payments');
  const p = school?.payments || {};
  res.json({
    success: true,
    data: {
      enabled: !!p.enabled, provider: p.provider || 'razorpay', keyId: p.keyId || '',
      hasKeySecret: !!p.keySecretEnc, hasWebhookSecret: !!p.webhookSecretEnc,
      webhookPath: `/api/payments/webhook/${req.schoolId}`,
    },
  });
});

// PUT /api/payments/settings { enabled, keyId, keySecret?, webhookSecret? } — secrets are write-only
exports.saveSettings = asyncHandler(async (req, res) => {
  const body = req.body || {};
  const school = await School.findById(req.schoolId);
  const p = school.payments || {};
  if (body.keyId !== undefined) {
    const keyId = String(body.keyId).trim();
    if (keyId && !/^rzp_(test|live)_[A-Za-z0-9]+$/.test(keyId)) throw new HttpError(400, 'Key ID should look like rzp_test_... or rzp_live_...');
    p.keyId = keyId;
  }
  if (body.keySecret) p.keySecretEnc = encrypt(String(body.keySecret).trim());
  if (body.webhookSecret) p.webhookSecretEnc = encrypt(String(body.webhookSecret).trim());
  if (body.enabled !== undefined) p.enabled = !!body.enabled;
  if (p.enabled && (!p.keyId || !p.keySecretEnc)) throw new HttpError(400, 'Add the Key ID and Key Secret before turning online payments on');
  school.payments = p;
  await school.save();
  res.json({ success: true, message: 'Payment settings saved' });
});

// ---------- Paying a fee (parent, student) ----------

// GET /api/payments/config — whether this school takes online payments
exports.getConfig = asyncHandler(async (req, res) => {
  const g = await gatewayFor(req.schoolId);
  res.json({ success: true, data: { enabled: g.enabled, provider: 'razorpay', keyId: g.enabled ? g.keyId : null } });
});

// POST /api/payments/orders { feeId, amount? } — amount defaults to the full balance
exports.createOrder = asyncHandler(async (req, res) => {
  const { feeId } = req.body || {};
  assertId(feeId, 'feeId');
  const fee = await Fee.findOne({ _id: feeId, school: req.schoolId });
  if (!fee) throw new HttpError(404, 'Fee record not found');
  const student = await Student.findOne({ _id: fee.studentId, school: req.schoolId });
  if (!(await canAccessStudent(req.user, student))) throw new HttpError(404, 'Fee record not found');

  const balance = Math.round((fee.amount - (fee.paidAmount || 0)) * 100) / 100;
  if (balance <= 0) throw new HttpError(409, 'This fee is already fully paid');
  const amount = req.body.amount === undefined || req.body.amount === '' ? balance : Math.round(Number(req.body.amount) * 100) / 100;
  if (!(amount >= 1)) throw new HttpError(400, 'The minimum online payment is Rs 1');
  if (amount > balance) throw new HttpError(400, `You can pay at most the outstanding balance of Rs ${balance}`);

  const g = await gatewayFor(req.schoolId);
  if (!g.enabled) throw unavailable('This school has not set up online payments yet. Please pay at the school office.');

  const order = await PaymentOrder.create({ school: req.schoolId, fee: fee._id, student: student._id, payer: req.user._id, amount });
  let remote;
  try {
    remote = await gateway.createOrder({
      keyId: g.keyId, keySecret: g.keySecret, amountPaise: Math.round(amount * 100), receipt: String(order._id),
      notes: { school: String(req.schoolId), fee: String(fee._id), student: student.name, feeType: fee.feeType },
    });
  } catch (err) {
    order.status = 'failed';
    order.note = String(err.message).slice(0, 300);
    await order.save();
    console.error('Razorpay order failed:', err.message);
    throw unavailable();
  }
  order.providerOrderId = remote.id;
  await order.save();

  res.status(201).json({
    success: true,
    data: {
      orderId: remote.id, keyId: g.keyId, amount: Math.round(amount * 100), currency: 'INR',
      name: g.school.name, description: `${fee.feeType} fee for ${student.name}`,
      prefill: { name: req.user.name, email: req.user.email, contact: req.user.phone || '' },
    },
  });
});

// Applies a paid order to its fee exactly once. Safe to call from both /verify and the webhook.
async function settle(order, paymentId) {
  // Claim the order; only one caller moves it out of "created".
  const claimed = await PaymentOrder.findOneAndUpdate(
    { _id: order._id, status: 'created' },
    { status: 'processing', providerPaymentId: paymentId },
    { returnDocument: 'after' },
  );
  if (!claimed) return PaymentOrder.findById(order._id); // already handled (or being handled)

  try {
    const { payment, duplicate } = await recordPayment({
      school: claimed.school, feeId: claimed.fee, amount: claimed.amount, mode: 'Online',
      reference: `Razorpay ${paymentId}`, collectedBy: claimed.payer, onlineOrder: claimed._id,
    });
    claimed.status = 'paid';
    claimed.receiptNo = payment.receiptNo;
    await claimed.save();

    if (duplicate) return claimed; // the other caller already applied it and told the parents
    const [fee, student] = await Promise.all([Fee.findById(claimed.fee), Student.findById(claimed.student)]);
    if (student) {
      await notifyParents(student, {
        title: 'Fee payment received',
        message: `Online payment of Rs ${claimed.amount} received for ${student.name} (${fee?.feeType || 'Fee'}). Receipt ${payment.receiptNo}.`,
        type: 'Fee',
      });
    }
    return claimed;
  } catch (err) {
    // The money was taken but could not be applied (for example the balance was cleared in cash meanwhile).
    claimed.status = 'needs_review';
    claimed.note = String(err.message).slice(0, 300);
    await claimed.save();
    const admins = await User.find({ school: claimed.school, role: { $in: ['admin', 'accountant'] }, isActive: true }).select('_id');
    await Promise.all(admins.map((a) => notifyUser(claimed.school, a._id, {
      title: 'Online payment needs review',
      message: `Payment ${paymentId} of Rs ${claimed.amount} could not be applied automatically: ${claimed.note}. Please reconcile it in Fee Collection.`,
      type: 'Fee',
    })));
    return claimed;
  }
}

// POST /api/payments/verify { razorpay_order_id, razorpay_payment_id, razorpay_signature }
exports.verifyPayment = asyncHandler(async (req, res) => {
  const { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature } = req.body || {};
  if (!orderId || !paymentId || !signature) throw new HttpError(400, 'Payment details are missing');
  const order = await PaymentOrder.findOne({ providerOrderId: String(orderId), school: req.schoolId, payer: req.user._id });
  if (!order) throw new HttpError(404, 'Payment order not found');
  const g = await gatewayFor(req.schoolId);
  if (!g.enabled || !gateway.verifyPaymentSignature({ orderId: order.providerOrderId, paymentId, signature, keySecret: g.keySecret })) {
    throw new HttpError(400, 'Payment could not be verified. If money was deducted, it will be confirmed automatically or refunded by the bank.');
  }
  const done = await settle(order, String(paymentId));
  res.json({
    success: done.status === 'paid',
    data: { status: done.status, receiptNo: done.receiptNo || null, feeId: done.fee, amount: done.amount },
    message: done.status === 'paid' ? 'Payment successful' : done.status === 'needs_review'
      ? 'Payment received. The school office will confirm it shortly.' : 'Payment is being confirmed',
  });
});

// POST /api/payments/webhook/:schoolId — called by Razorpay with the raw JSON body (no login)
exports.webhook = async (req, res) => {
  try {
    if (!/^[a-f0-9]{24}$/i.test(req.params.schoolId)) return res.status(404).end();
    const g = await gatewayFor(req.params.schoolId);
    const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    if (!g.webhookSecret || !gateway.verifyWebhookSignature({ rawBody, signature: req.get('x-razorpay-signature'), webhookSecret: g.webhookSecret })) {
      return res.status(400).json({ success: false });
    }
    const event = JSON.parse(rawBody);
    const payment = event?.payload?.payment?.entity;
    const orderId = payment?.order_id || event?.payload?.order?.entity?.id;
    if (['payment.captured', 'order.paid'].includes(event.event) && orderId && payment?.id) {
      const order = await PaymentOrder.findOne({ providerOrderId: orderId, school: req.params.schoolId });
      if (order) await settle(order, payment.id);
    } else if (event.event === 'payment.failed' && orderId) {
      await PaymentOrder.updateOne({ providerOrderId: orderId, school: req.params.schoolId, status: 'created' }, { status: 'failed', note: payment?.error_description || 'Payment failed' });
    }
    return res.json({ success: true });
  } catch (err) {
    console.error('Payment webhook failed:', err.message);
    return res.status(500).json({ success: false }); // Razorpay retries on failure
  }
};

// GET /api/payments/orders?status=needs_review (admin/accountant) — online payments for reconciliation
exports.listOrders = asyncHandler(async (req, res) => {
  const filter = { school: req.schoolId };
  if (req.query.status) filter.status = String(req.query.status);
  const orders = await PaymentOrder.find(filter).sort({ createdAt: -1 }).limit(200)
    .populate('student', 'name class section').populate('fee', 'feeType amount paidAmount');
  res.json({ success: true, data: orders });
});
