// SMS provider adapters and the saved SMS settings. An adapter has one job: send(settings, phone, otp) -> { accepted, simulated }.
// "test" never touches the network. The two real providers are written against their public APIs and have NOT been exercised with
// real credentials in this repository (see docs/INTEGRATIONS.md).
const axios = require('axios');
const PlatformSetting = require('../models/PlatformSetting');
const { encrypt } = require('./secrets');
const { log, describeError, maskPhone, assertKeyForSecrets, readSecret } = require('./integrations');
const { HttpError } = require('../utils/http');

const PROVIDERS = ['test', 'msg91', 'twilio'];
const MODES = ['test', 'production'];

// "9876543210" -> "+919876543210" (India); a number with a country code must be E.164.
function normalizePhone(input) {
  const raw = String(input || '').replace(/[\s()-]/g, '');
  if (/^[6-9]\d{9}$/.test(raw)) return `+91${raw}`;
  if (/^0?91[6-9]\d{9}$/.test(raw)) return `+91${raw.slice(-10)}`;
  if (/^\+[1-9]\d{7,14}$/.test(raw)) return raw;
  throw new HttpError(400, 'Enter a valid mobile number (10 digits, or with country code like +91...)');
}

const intIn = (v, min, max, name) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${name} must be a whole number from ${min} to ${max}`);
  return n;
};

function cleanSmsConfig(input = {}, prev = {}) {
  const c = { otpExpirySeconds: 300, resendCooldownSeconds: 60, maxAttempts: 5, hourlyLimitPerPhone: 5, mode: 'test', provider: 'test', ...prev };
  if (input.provider !== undefined) { if (!PROVIDERS.includes(input.provider)) throw new HttpError(400, `Provider must be one of ${PROVIDERS.join(', ')}`); c.provider = input.provider; }
  if (input.mode !== undefined) { if (!MODES.includes(input.mode)) throw new HttpError(400, 'Mode must be test or production'); c.mode = input.mode; }
  if (input.otpExpirySeconds !== undefined) c.otpExpirySeconds = intIn(input.otpExpirySeconds, 60, 900, 'Code expiry (seconds)');
  if (input.resendCooldownSeconds !== undefined) c.resendCooldownSeconds = intIn(input.resendCooldownSeconds, 15, 600, 'Resend wait (seconds)');
  if (input.maxAttempts !== undefined) c.maxAttempts = intIn(input.maxAttempts, 1, 10, 'Maximum attempts');
  if (input.hourlyLimitPerPhone !== undefined) c.hourlyLimitPerPhone = intIn(input.hourlyLimitPerPhone, 1, 20, 'Codes per phone per hour');
  for (const [f, max, re] of [['senderId', 20, /^[A-Za-z0-9+ ]*$/], ['templateId', 64, /^[A-Za-z0-9_-]*$/], ['accountSid', 64, /^[A-Za-z0-9]*$/]]) {
    if (input[f] === undefined) continue;
    const v = String(input[f]).trim().slice(0, max);
    if (!re.test(v)) throw new HttpError(400, `${f} has characters that are not allowed`);
    c[f] = v;
  }
  return c;
}

async function saveSms({ enabled, config, apiKey, clearApiKey }, actor) {
  const doc = (await PlatformSetting.findOne({ key: 'sms' }).select('+secrets')) || new PlatformSetting({ key: 'sms', config: {} });
  const before = JSON.stringify([doc.config, !!doc.secrets?.apiKey]);
  const next = cleanSmsConfig(config, doc.config || {});
  const secrets = { ...(doc.secrets || {}) };
  if (clearApiKey) delete secrets.apiKey; else if (typeof apiKey === 'string' && apiKey !== '') { assertKeyForSecrets(); secrets.apiKey = encrypt(apiKey); }
  if (next.provider !== 'test') {
    if (!secrets.apiKey && enabled === true) throw new HttpError(400, 'Enter the provider API key before switching SMS on');
    if (next.provider === 'twilio' && enabled === true && (!next.accountSid || !next.senderId)) throw new HttpError(400, 'Twilio needs the account SID and a sender number');
    if (next.provider === 'msg91' && enabled === true && !next.templateId) throw new HttpError(400, 'MSG91 needs the approved OTP template ID');
  }
  if (next.provider !== 'test' && next.mode === 'production' && enabled === true && !doc.status?.lastAcceptedAt) {
    throw new HttpError(409, 'Production needs one real test SMS accepted by the provider first. Send one with "Send a real SMS" in the test flow.');
  }
  doc.config = next; doc.secrets = secrets; doc.markModified('config'); doc.markModified('secrets');
  if (typeof enabled === 'boolean') doc.enabled = enabled;
  if (JSON.stringify([next, !!secrets.apiKey]) !== before) { doc.status.lastAcceptedAt = undefined; doc.status.lastTestOk = undefined; }
  doc.updatedBy = actor?._id;
  await doc.save();
  await log('sms', 'config', true, { message: 'Configuration saved', actor: actor?._id });
  return doc;
}

async function loadSms() {
  return (await PlatformSetting.findOne({ key: 'sms' }).select('+secrets')) || new PlatformSetting({ key: 'sms', config: cleanSmsConfig({}) });
}

const adapters = {
  async test() { return { accepted: true, simulated: true }; },

  // MSG91 OTP API (India). Needs an approved sender and an approved DLT template; the API key is the account "authkey".
  async msg91(c, phone, otp, key) {
    const r = await axios.post('https://control.msg91.com/api/v5/otp', null, {
      params: { template_id: c.templateId, mobile: phone.replace('+', ''), otp, otp_expiry: Math.ceil(c.otpExpirySeconds / 60), ...(c.senderId ? { sender: c.senderId } : {}) },
      headers: { authkey: key, 'Content-Type': 'application/json' }, timeout: 15000, maxRedirects: 0,
    });
    if (r.data?.type && r.data.type !== 'success') throw Object.assign(new Error(r.data.message || 'Rejected by MSG91'), { code: 'EPROVIDER' });
    return { accepted: true, simulated: false };
  },

  // Twilio Messages API. senderId is the Twilio number (or messaging service) the code is sent from.
  async twilio(c, phone, otp, key) {
    const body = new URLSearchParams({ To: phone, From: c.senderId, Body: `Your EduAmigo code is ${otp}. It expires in ${Math.ceil(c.otpExpirySeconds / 60)} minutes. Do not share it.` });
    await axios.post(`https://api.twilio.com/2010-04-01/Accounts/${c.accountSid}/Messages.json`, body.toString(), {
      auth: { username: c.accountSid, password: key }, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000, maxRedirects: 0,
    });
    return { accepted: true, simulated: false };
  },
};

// Whether a message may leave the server. Only two ways: SMS is switched on in production mode with a real provider, or the owner
// explicitly asked for one real test send (`live`) from the console. Everything else is simulated.
const goesLive = (c, enabled, live) => c.provider !== 'test' && (live === true || (enabled === true && c.mode === 'production'));

async function sendCode(doc, phone, otp, actor, { live = false } = {}) {
  const c = doc.config;
  const adapter = goesLive(c, doc.enabled, live) ? c.provider : 'test';
  let key = '';
  try {
    if (adapter !== 'test') {
      if (!doc.secrets?.apiKey) throw Object.assign(new Error('No API key is saved'), { code: 'EKEY' });
      key = readSecret(doc.secrets.apiKey);
    }
    const r = await adapters[adapter](c, phone, otp, key);
    if (!r.simulated) { doc.status.lastAcceptedAt = new Date(); await doc.save(); }
    await log('sms', 'send', true, { message: r.simulated ? 'Simulated (test mode, nothing sent)' : 'Accepted by the SMS provider', target: maskPhone(phone), actor });
    return r;
  } catch (err) {
    const d = describeError(err, [key, phone, otp]);
    doc.status.lastFailureAt = new Date(); await doc.save();
    await log('sms', 'send', false, { ...d, target: maskPhone(phone), actor });
    throw Object.assign(new HttpError(502, `The SMS provider did not accept the message: ${d.message}`), { sanitized: true });
  }
}

module.exports = { goesLive, saveSms, loadSms, sendCode, normalizePhone, cleanSmsConfig, PROVIDERS, MODES };
