// Platform integrations the owner configures in the console: outgoing email (SMTP) and SMS/OTP.
// Rules kept here: secrets are encrypted at rest and never returned; "saved" is not "verified" (a login to the provider must
// succeed) and "verified" is not "delivered" (a person must confirm the message arrived); every attempt leaves a sanitized log row.
const nodemailer = require('nodemailer');
const dns = require('dns').promises;
const PlatformSetting = require('../models/PlatformSetting');
const IntegrationLog = require('../models/IntegrationLog');
const { encrypt, decrypt } = require('./secrets');
const { resolvePublicHost } = require('./netGuard');
const { HttpError } = require('../utils/http');

const EMAIL_RE = /^[^\s@<>()]+@[^\s@<>()]+\.[^\s@<>()]{2,}$/;
const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i;
const SMTP_PORTS = [25, 465, 587, 2525];
const SECURITY = ['ssl', 'starttls', 'none'];

const SECRET_FIELDS = { email: ['password'], sms: ['apiKey'] };

// ---------- secrets ----------
// Production must have its own encryption key: without it the key would come from JWT_SECRET, and rotating that would silently
// make every saved password unreadable.
function assertKeyForSecrets() {
  if (process.env.NODE_ENV !== 'production') return;
  if (String(process.env.DATA_ENCRYPTION_KEY || '').length < 32) throw new HttpError(503, 'Set DATA_ENCRYPTION_KEY (at least 32 random characters) on the server before saving a password or API key');
}
// Decrypts a saved secret; a value that can no longer be read (the encryption key changed) is reported as such.
function readSecret(stored) {
  if (!stored) return '';
  try { return decrypt(stored); } catch { throw Object.assign(new Error('The saved secret cannot be read'), { code: 'EKEY' }); }
}
function unreadable(secrets = {}) {
  return Object.fromEntries(Object.entries(secrets).filter(([, v]) => v).map(([k, v]) => { try { decrypt(v); return [k, false]; } catch { return [k, true]; } }));
}

// ---------- sanitizing ----------
function mask(email) {
  const [u = '', d = ''] = String(email).split('@');
  return `${u.slice(0, 1)}***@${d}`;
}
const maskPhone = (p) => `${'*'.repeat(Math.max(0, String(p).length - 4))}${String(p).slice(-4)}`;

// Error text that is safe to store and show: a short code, a plain sentence, and none of the secrets that were in use.
function describeError(err, secrets = []) {
  const code = String(err?.code || err?.responseCode || 'ERROR').slice(0, 20);
  const plain = {
    EAUTH: 'The mail server rejected the username or password',
    ECONNECTION: 'Could not connect to the mail server',
    ECONNREFUSED: 'The mail server refused the connection (check host and port)',
    ETIMEDOUT: 'The mail server did not answer in time',
    ESOCKET: 'The secure connection to the mail server failed (check the security mode and port)',
    EDNS: 'The mail server name could not be found',
    EBLOCKED: 'This address points to a private or internal network and is not allowed',
    EENVELOPE: 'The mail server did not accept the sender or recipient address',
    EMESSAGE: 'The mail server rejected the message',
    ENOTFOUND: 'The mail server name could not be found',
    EKEY: 'The saved password can no longer be read (the server encryption key changed). Enter it again and save.',
  }[code];
  let message = plain || String(err?.message || 'The request failed').split('\n')[0];
  for (const s of secrets.filter((x) => x && String(x).length >= 4)) message = message.split(String(s)).join('***');
  // Addresses and numbers that a provider echoes back are personal data too.
  message = message.replace(/[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+/g, '***@***').replace(/\+?\d[\d ()-]{7,}\d/g, '***');
  return { code, message: message.slice(0, 240) };
}

async function log(kind, action, ok, { code = '', message = '', target = '', actor } = {}) {
  try { await IntegrationLog.create({ kind, action, ok, code, message: String(message).slice(0, 300), target, actor }); } catch (e) { console.error('integration log failed:', e.message); }
}

// ---------- settings storage ----------
async function load(key, { withSecrets = false } = {}) {
  const q = PlatformSetting.findOne({ key });
  if (withSecrets) q.select('+secrets');
  return (await q) || new PlatformSetting({ key, config: {} });
}

function secretFlags(doc, key) {
  const s = doc.secrets || {};
  return Object.fromEntries(SECRET_FIELDS[key].map((f) => [f, !!s[f]]));
}

// What the console may see: configuration, whether each secret is set, and the observed status. Never a secret.
async function view(key) {
  const doc = await load(key, { withSecrets: true });
  return {
    key, enabled: !!doc.enabled, config: doc.config || {}, secretsSet: secretFlags(doc, key),
    secretsUnreadable: unreadable(doc.secrets), status: doc.status ? doc.status.toObject?.() ?? doc.status : {}, updatedAt: doc.updatedAt || null,
  };
}

// ---------- email ----------
function cleanEmailConfig(input = {}, previous = {}) {
  const c = { ...previous };
  const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : undefined);
  if (input.provider !== undefined && input.provider !== 'smtp') throw new HttpError(400, 'Only SMTP is supported for outgoing email here');
  c.provider = 'smtp';
  if (input.host !== undefined) {
    const host = str(input.host, 253)?.toLowerCase();
    if (!host || !HOST_RE.test(host)) throw new HttpError(400, 'Enter the mail server name, for example smtp.example.com');
    c.host = host;
  }
  if (input.port !== undefined) {
    const port = Number(input.port);
    if (!Number.isInteger(port) || !SMTP_PORTS.includes(port)) throw new HttpError(400, `Port must be one of ${SMTP_PORTS.join(', ')}`);
    c.port = port;
  }
  if (input.security !== undefined) {
    if (!SECURITY.includes(input.security)) throw new HttpError(400, 'Security must be ssl, starttls or none');
    c.security = input.security;
  }
  if (c.security === 'none' && process.env.NODE_ENV === 'production') throw new HttpError(400, 'An unencrypted connection is not allowed in production');
  for (const [f, max] of [['username', 200], ['fromName', 80]]) if (input[f] !== undefined) c[f] = str(input[f], max) ?? '';
  for (const f of ['fromEmail', 'replyTo']) {
    if (input[f] === undefined) continue;
    const v = str(input[f], 200) ?? '';
    if (v && !EMAIL_RE.test(v)) throw new HttpError(400, `${f === 'fromEmail' ? 'From' : 'Reply-to'} address is not a valid email address`);
    c[f] = v;
  }
  if (input.timeoutMs !== undefined) {
    const t = Number(input.timeoutMs);
    if (!Number.isInteger(t) || t < 1000 || t > 30000) throw new HttpError(400, 'Timeout must be between 1000 and 30000 milliseconds');
    c.timeoutMs = t;
  }
  return c;
}

async function saveEmail({ enabled, config, password, clearPassword }, actor) {
  const doc = await load('email', { withSecrets: true });
  const before = JSON.stringify([doc.config, !!doc.secrets?.password]);
  const next = cleanEmailConfig(config, doc.config || {});
  next.port = next.port || 587;
  next.security = next.security || (next.port === 465 ? 'ssl' : 'starttls');
  next.timeoutMs = next.timeoutMs || 10000;
  const secrets = { ...(doc.secrets || {}) };
  if (clearPassword) delete secrets.password;
  else if (typeof password === 'string' && password !== '') { assertKeyForSecrets(); secrets.password = encrypt(password); }
  if (enabled === true) {
    if (!next.host || !next.fromEmail) throw new HttpError(400, 'Fill in the mail server and the From address before switching email on');
  }
  doc.config = next;
  doc.secrets = secrets;
  doc.markModified('config'); doc.markModified('secrets');
  if (typeof enabled === 'boolean') doc.enabled = enabled;
  // Different server, login or sender than the one that was verified: the verification no longer applies.
  const changed = JSON.stringify([next, !!secrets.password]) !== before || (typeof password === 'string' && password !== '');
  if (changed) { doc.status.connectionVerifiedAt = undefined; doc.status.connectionError = ''; doc.status.inboxConfirmedAt = undefined; doc.status.lastAcceptedAt = undefined; }
  if (enabled === true && !doc.status.connectionVerifiedAt) throw new HttpError(409, 'Verify the connection before switching email on');
  if (!doc.status.connectionVerifiedAt) doc.enabled = false;
  doc.updatedBy = actor?._id;
  await doc.save();
  await log('email', 'config', true, { message: changed ? 'Configuration saved' : 'Configuration unchanged', actor: actor?._id });
  return { doc, changed };
}

async function transportFor(doc) {
  const c = doc.config || {};
  const address = await resolvePublicHost(c.host);
  const secret = readSecret(doc.secrets?.password);
  const transport = nodemailer.createTransport({
    host: address, port: c.port, secure: c.security === 'ssl', requireTLS: c.security === 'starttls', ignoreTLS: c.security === 'none',
    tls: { servername: c.host, rejectUnauthorized: process.env.ALLOW_PRIVATE_SMTP_HOSTS === 'true' ? false : true },
    auth: c.username ? { user: c.username, pass: secret } : undefined,
    connectionTimeout: c.timeoutMs, greetingTimeout: c.timeoutMs, socketTimeout: c.timeoutMs,
    disableFileAccess: true, disableUrlAccess: true,
  });
  return { transport, secret };
}

// Opens a connection and logs in, nothing more. Records the outcome. Does NOT send any message.
async function verifyEmail(actor) {
  const doc = await load('email', { withSecrets: true });
  if (!doc.config?.host) throw new HttpError(400, 'Save the mail server settings first');
  let secret = '';
  try {
    const t = await transportFor(doc); secret = t.secret;
    await t.transport.verify();
    doc.status.connectionVerifiedAt = new Date(); doc.status.connectionError = '';
    await doc.save();
    await log('email', 'verify', true, { message: 'Connection and login succeeded', actor: actor?._id });
    return { ok: true, message: 'Connected and signed in to the mail server. No message was sent.' };
  } catch (err) {
    const d = describeError(err, [secret, doc.config?.username]);
    doc.status.connectionVerifiedAt = undefined; doc.status.connectionError = d.message; doc.status.lastFailureAt = new Date();
    doc.enabled = false;
    await doc.save();
    await log('email', 'verify', false, { ...d, actor: actor?._id });
    return { ok: false, code: d.code, message: d.message };
  }
}

async function sendThrough(doc, { to, subject, text }) {
  const c = doc.config;
  const { transport, secret } = await transportFor(doc);
  try {
    const info = await transport.sendMail({
      from: c.fromName ? { name: c.fromName, address: c.fromEmail } : c.fromEmail, to, subject, text,
      ...(c.replyTo ? { replyTo: c.replyTo } : {}),
    });
    return { accepted: (info.accepted || []).length > 0, rejected: info.rejected || [] };
  } catch (err) { err.secretsInUse = [secret, c.username]; throw err; }
}

async function testEmail(to, actor) {
  if (!EMAIL_RE.test(String(to || ''))) throw new HttpError(400, 'Enter the email address to send the test to');
  const since = new Date(Date.now() - 3600 * 1000);
  const recent = await IntegrationLog.countDocuments({ kind: 'email', action: 'test_send', actor: actor?._id, createdAt: { $gte: since } });
  if (recent >= 10) throw new HttpError(429, 'Test email limit reached (10 per hour). Try again later.');
  const doc = await load('email', { withSecrets: true });
  if (!doc.config?.host || !doc.config?.fromEmail) throw new HttpError(400, 'Save the mail server and From address first');
  try {
    const r = await sendThrough(doc, { to, subject: 'EduAmigo test email', text: 'This is a test message from the EduAmigo owner console. If you can read it, outgoing email works. No action is needed.' });
    if (!r.accepted) throw Object.assign(new Error('The recipient was rejected'), { code: 'EENVELOPE' });
    doc.status.lastTestAt = new Date(); doc.status.lastTestOk = true; doc.status.lastAcceptedAt = new Date(); doc.status.lastTestMessage = 'Accepted by the mail server';
    await doc.save();
    await log('email', 'test_send', true, { message: 'Accepted by the mail server', target: mask(to), actor: actor?._id });
    return { ok: true, message: 'The mail server accepted the message. Check the inbox, then confirm it arrived.' };
  } catch (err) {
    const d = describeError(err, err.secretsInUse || []);
    doc.status.lastTestAt = new Date(); doc.status.lastTestOk = false; doc.status.lastTestMessage = d.message; doc.status.lastFailureAt = new Date();
    await doc.save();
    await log('email', 'test_send', false, { ...d, target: mask(to), actor: actor?._id });
    return { ok: false, code: d.code, message: d.message };
  }
}

async function confirmInbox(actor) {
  const doc = await load('email');
  if (!doc.status?.lastAcceptedAt) throw new HttpError(400, 'Send a test email first');
  doc.status.inboxConfirmedAt = new Date();
  await doc.save();
  await log('email', 'test_send', true, { message: 'A person confirmed the test email arrived', actor: actor?._id });
}

// Advisory checks on the From address: format, alignment with the login, and the DNS records receivers look at.
async function senderChecks(actor) {
  const doc = await load('email');
  const c = doc.config || {};
  if (!c.fromEmail) throw new HttpError(400, 'Save a From address first');
  const domain = c.fromEmail.split('@')[1].toLowerCase();
  const txt = async (name) => { try { return (await dns.resolveTxt(name)).map((r) => r.join('')); } catch { return null; } };
  const [root, dmarc] = await Promise.all([txt(domain), txt(`_dmarc.${domain}`)]);
  const checks = [
    { id: 'format', ok: true, text: 'The From address is a valid email address' },
    { id: 'login-domain', ok: !c.username?.includes('@') || c.username.split('@')[1].toLowerCase() === domain, text: 'The From domain matches the mail login domain (providers often reject a different domain)' },
    { id: 'spf', ok: root === null ? null : root.some((t) => t.toLowerCase().startsWith('v=spf1')), text: 'The domain publishes an SPF record' },
    { id: 'dmarc', ok: dmarc === null ? null : dmarc.some((t) => t.toLowerCase().startsWith('v=dmarc1')), text: 'The domain publishes a DMARC record' },
  ];
  await log('email', 'sender_check', checks.every((x) => x.ok !== false), { message: `${checks.filter((x) => x.ok === false).length} advisory issue(s)`, actor: actor?._id });
  return { domain, checks, note: 'DNS checks are advisory (null means the lookup could not be done). DKIM cannot be checked without the provider selector, so check it in the provider dashboard.' };
}

// Used by services/email.js: the stored SMTP settings when email is switched on and verified, otherwise null.
async function activeEmail() {
  try {
    const doc = await load('email', { withSecrets: true });
    if (doc.enabled && doc.status?.connectionVerifiedAt && doc.config?.host) return doc;
  } catch { /* database not ready: fall back to environment settings */ }
  return null;
}

async function recordDelivery(ok, err) {
  try {
    const doc = await load('email');
    if (ok) { doc.status.lastAcceptedAt = new Date(); await doc.save(); await log('email', 'send', true, { message: 'Accepted by the mail server' }); }
    else { const d = describeError(err, err?.secretsInUse || []); doc.status.lastFailureAt = new Date(); await doc.save(); await log('email', 'send', false, d); }
  } catch { /* logging must never break a send */ }
}

module.exports = {
  assertKeyForSecrets, readSecret, unreadable, load, view, saveEmail, verifyEmail, testEmail, confirmInbox, senderChecks, activeEmail, sendThrough, recordDelivery,
  log, describeError, mask, maskPhone, cleanEmailConfig, EMAIL_RE, SECRET_FIELDS, secretFlags,
};
