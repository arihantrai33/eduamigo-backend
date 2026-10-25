// Phone one-time codes: random 6 digits, stored only as keyed hashes, expire, can be used once, limited attempts, a wait before
// a resend, and a per-phone hourly cap. The service never looks at accounts, so its answers cannot reveal whether a number or an
// email belongs to anyone.
const crypto = require('crypto');
const PhoneOtp = require('../models/PhoneOtp');
const { loadSms, sendCode, normalizePhone } = require('./sms');
const { log, maskPhone } = require('./integrations');
const { HttpError } = require('../utils/http');

const keyed = (value) => crypto.createHmac('sha256', process.env.DATA_ENCRYPTION_KEY || process.env.JWT_SECRET || '').update(String(value)).digest('hex');
const generate = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');

async function requestCode(phoneInput, { purpose = 'test', actor, live = false } = {}) {
  const phone = normalizePhone(phoneInput);
  const doc = await loadSms();
  const c = doc.config;
  const phoneHash = keyed(`phone:${phone}`);
  const now = Date.now();

  const last = await PhoneOtp.findOne({ phoneHash, purpose }).sort({ sentAt: -1 });
  if (last && now - last.sentAt.getTime() < c.resendCooldownSeconds * 1000) {
    const wait = Math.ceil((c.resendCooldownSeconds * 1000 - (now - last.sentAt.getTime())) / 1000);
    throw Object.assign(new HttpError(429, `Please wait ${wait} seconds before asking for another code`), { extra: { retryAfterSeconds: wait } });
  }
  const sentLastHour = await PhoneOtp.countDocuments({ phoneHash, purpose, sentAt: { $gte: new Date(now - 3600 * 1000) } });
  if (sentLastHour >= c.hourlyLimitPerPhone) throw new HttpError(429, 'Too many codes were requested for this number. Try again later.');

  const code = generate();
  const row = await PhoneOtp.create({ phoneHash, purpose, codeHash: 'pending', maxAttempts: c.maxAttempts, expiresAt: new Date(now + c.otpExpirySeconds * 1000) });
  // Two requests at the same instant can both pass the checks above: the earliest one wins, the other is withdrawn.
  const clash = await PhoneOtp.countDocuments({ phoneHash, purpose, _id: { $lt: row._id }, sentAt: { $gte: new Date(now - c.resendCooldownSeconds * 1000) } });
  if (clash) { await PhoneOtp.deleteOne({ _id: row._id }); throw Object.assign(new HttpError(429, 'A code was just sent. Please wait before asking again.'), { extra: { retryAfterSeconds: c.resendCooldownSeconds } }); }
  row.codeHash = keyed(`code:${row._id}:${code}`);
  await row.save();
  await PhoneOtp.updateMany({ phoneHash, purpose, _id: { $ne: row._id }, usedAt: null }, { $set: { usedAt: new Date() } }); // older codes stop working
  try {
    const sent = await sendCode(doc, phone, code, actor, { live });
    await log('sms', 'otp_request', true, { message: sent.simulated ? 'Code created (test mode)' : 'Code sent', target: maskPhone(phone), actor });
    return { expiresInSeconds: c.otpExpirySeconds, resendAfterSeconds: c.resendCooldownSeconds, simulated: !!sent.simulated, ...(sent.simulated && c.provider === 'test' ? { testCode: code } : {}) };
  } catch (err) {
    await PhoneOtp.deleteOne({ _id: row._id });
    await log('sms', 'otp_request', false, { code: 'SEND', message: 'Sending failed', target: maskPhone(phone), actor });
    throw err;
  }
}

async function verifyCode(phoneInput, codeInput, { purpose = 'test', actor } = {}) {
  const phone = normalizePhone(phoneInput);
  const code = String(codeInput || '').trim();
  const bad = new HttpError(400, 'That code is not correct or has expired');
  if (!/^\d{6}$/.test(code)) throw bad;
  const phoneHash = keyed(`phone:${phone}`);
  const row = await PhoneOtp.findOne({ phoneHash, purpose, usedAt: null, expiresAt: { $gt: new Date() } }).sort({ sentAt: -1 });
  if (!row) { await log('sms', 'otp_verify', false, { code: 'NONE', message: 'No active code', target: maskPhone(phone), actor }); throw bad; }
  // Count the attempt first, atomically, so parallel guesses cannot exceed the limit.
  const counted = await PhoneOtp.findOneAndUpdate({ _id: row._id, usedAt: null, attempts: { $lt: row.maxAttempts } }, { $inc: { attempts: 1 } }, { returnDocument: 'after' });
  if (!counted) { await log('sms', 'otp_verify', false, { code: 'LOCKED', message: 'Attempt limit reached', target: maskPhone(phone), actor }); throw new HttpError(429, 'Too many wrong codes. Ask for a new code.'); }
  const expected = Buffer.from(keyed(`code:${row._id}:${code}`)); const actual = Buffer.from(row.codeHash);
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    await log('sms', 'otp_verify', false, { code: 'WRONG', message: 'Wrong code', target: maskPhone(phone), actor }); throw bad;
  }
  const used = await PhoneOtp.findOneAndUpdate({ _id: row._id, usedAt: null }, { $set: { usedAt: new Date() } }, { returnDocument: 'after' });
  if (!used) throw bad; // someone else used it in the same instant: single use
  await log('sms', 'otp_verify', true, { message: 'Code verified', target: maskPhone(phone), actor });
  return { verified: true };
}

module.exports = { requestCode, verifyCode };
