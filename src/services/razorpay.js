// Minimal Razorpay client: create an order, and verify payment and webhook signatures.
// Uses the REST API directly so no SDK is needed. Tests replace createOrder via setTransport().
const crypto = require('crypto');

const API = 'https://api.razorpay.com/v1';
let transport = (url, init) => fetch(url, init);
function setTransport(fn) { transport = fn; }

async function createOrder({ keyId, keySecret, amountPaise, receipt, notes }) {
  const res = await transport(`${API}/orders`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`,
    },
    body: JSON.stringify({ amount: amountPaise, currency: 'INR', receipt: String(receipt).slice(0, 40), notes }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const reason = body?.error?.description || `status ${res.status}`;
    // Surfaced to the user as a 502: the problem is with the gateway or the school's keys, not the request.
    throw Object.assign(new Error(`Payment gateway refused the order: ${reason}`), { status: 502, expose: true });
  }
  return body; // { id, amount, currency, status, ... }
}

const hmac = (secret, payload) => crypto.createHmac('sha256', secret).update(payload).digest('hex');
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// Checkout success: signature = HMAC_SHA256(order_id + "|" + payment_id, key_secret)
function verifyPaymentSignature({ orderId, paymentId, signature, keySecret }) {
  return safeEqual(hmac(keySecret, `${orderId}|${paymentId}`), signature);
}

// Webhook: signature = HMAC_SHA256(raw request body, webhook_secret)
function verifyWebhookSignature({ rawBody, signature, webhookSecret }) {
  return safeEqual(hmac(webhookSecret, rawBody), signature);
}

module.exports = { createOrder, verifyPaymentSignature, verifyWebhookSignature, setTransport, hmac };
