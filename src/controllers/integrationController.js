// Owner console: Email & SMS integrations and platform health. Reached only through routes/platformRoutes.js (platform token,
// role superadmin). Responses carry configuration and observed status, never a secret.
const mongoose = require('mongoose');
const IntegrationLog = require('../models/IntegrationLog');
const integrations = require('../services/integrations');
const sms = require('../services/sms');
const otp = require('../services/otp');
const { asyncHandler, HttpError } = require('../utils/http');
const { audit } = require('../services/audit');

const sanitizedSms = async () => {
  const doc = await sms.loadSms();
  return { key: 'sms', enabled: !!doc.enabled, config: doc.config, secretsSet: integrations.secretFlags(doc, 'sms'), secretsUnreadable: integrations.unreadable(doc.secrets), status: doc.status?.toObject?.() ?? doc.status ?? {}, updatedAt: doc.updatedAt || null };
};

// Evidence-based label: only "verified" when a check really succeeded.
function stateOf(kind, v) {
  const s = v.status || {};
  if (kind === 'email') {
    if (!v.config?.host) return 'unconfigured';
    if (!v.enabled) return s.connectionVerifiedAt ? 'verified-disabled' : 'unverified';
    if (s.lastFailureAt && (!s.lastAcceptedAt || s.lastFailureAt > s.lastAcceptedAt)) return 'degraded';
    return s.inboxConfirmedAt ? 'verified' : 'connected';
  }
  if (!v.enabled) return v.config?.provider && v.config.provider !== 'test' ? 'unverified' : 'test-mode';
  if (v.config.mode === 'test') return 'test-mode';
  if (s.lastFailureAt && (!s.lastAcceptedAt || s.lastFailureAt > s.lastAcceptedAt)) return 'degraded';
  return s.lastAcceptedAt ? 'connected' : 'unverified';
}

exports.overview = asyncHandler(async (req, res) => {
  const [email, smsView] = await Promise.all([integrations.view('email'), sanitizedSms()]);
  const env = require('../services/email');
  res.json({
    success: true,
    data: {
      email: { ...email, state: stateOf('email', email), fallback: { provider: env.provider() || 'none', configured: env.isConfigured() } },
      sms: { ...smsView, state: stateOf('sms', smsView) },
      providers: { sms: sms.PROVIDERS, smtpPorts: [25, 465, 587, 2525] },
    },
  });
});

exports.saveEmail = asyncHandler(async (req, res) => {
  const b = req.body || {};
  const { changed } = await integrations.saveEmail({ enabled: b.enabled, config: b.config, password: b.password, clearPassword: b.clearPassword === true }, req.platformUser);
  await audit(req, 'platform.integration_saved', { school: null, targetType: 'integration', targetId: 'email', details: { changed, enabled: b.enabled, fields: Object.keys(b.config || {}), passwordChanged: typeof b.password === 'string' && b.password !== '', passwordCleared: b.clearPassword === true } });
  const v = await integrations.view('email');
  res.json({ success: true, data: { ...v, state: stateOf('email', v) } });
});

exports.verifyEmail = asyncHandler(async (req, res) => {
  const r = await integrations.verifyEmail(req.platformUser);
  await audit(req, 'platform.integration_verified', { school: null, targetType: 'integration', targetId: 'email', details: { ok: r.ok, code: r.code || '' } });
  res.json({ success: true, data: r });
});

exports.senderChecks = asyncHandler(async (req, res) => res.json({ success: true, data: await integrations.senderChecks(req.platformUser) }));

exports.testEmail = asyncHandler(async (req, res) => {
  const r = await integrations.testEmail(req.body?.to, req.platformUser);
  await audit(req, 'platform.integration_test', { school: null, targetType: 'integration', targetId: 'email', details: { ok: r.ok, code: r.code || '' } });
  res.json({ success: true, data: r });
});

exports.confirmEmail = asyncHandler(async (req, res) => {
  await integrations.confirmInbox(req.platformUser);
  await audit(req, 'platform.integration_confirmed', { school: null, targetType: 'integration', targetId: 'email' });
  const v = await integrations.view('email');
  res.json({ success: true, data: { ...v, state: stateOf('email', v) } });
});

exports.saveSms = asyncHandler(async (req, res) => {
  const b = req.body || {};
  await sms.saveSms({ enabled: b.enabled, config: b.config, apiKey: b.apiKey, clearApiKey: b.clearApiKey === true }, req.platformUser);
  await audit(req, 'platform.integration_saved', { school: null, targetType: 'integration', targetId: 'sms', details: { enabled: b.enabled, fields: Object.keys(b.config || {}), keyChanged: typeof b.apiKey === 'string' && b.apiKey !== '', keyCleared: b.clearApiKey === true } });
  const v = await sanitizedSms();
  res.json({ success: true, data: { ...v, state: stateOf('sms', v) } });
});

exports.requestOtp = asyncHandler(async (req, res) => {
  const live = req.body?.live === true;
  if (live) {
    const doc = await require('../services/sms').loadSms();
    if (doc.config.provider === 'test') throw new HttpError(400, 'Choose a real provider and save its credentials before sending a real SMS');
  }
  const r = await otp.requestCode(req.body?.phone, { purpose: 'console-test', actor: req.platformUser._id, live });
  await audit(req, 'platform.integration_test', { school: null, targetType: 'integration', targetId: 'sms', details: { step: 'request', simulated: r.simulated, live } });
  res.json({ success: true, data: r });
});

exports.verifyOtp = asyncHandler(async (req, res) => {
  const r = await otp.verifyCode(req.body?.phone, req.body?.code, { purpose: 'console-test', actor: req.platformUser._id });
  await audit(req, 'platform.integration_test', { school: null, targetType: 'integration', targetId: 'sms', details: { step: 'verify', verified: true } });
  res.json({ success: true, data: r });
});

exports.logs = asyncHandler(async (req, res) => {
  const filter = {};
  if (['email', 'sms'].includes(req.query.kind)) filter.kind = req.query.kind;
  if (req.query.ok === 'true' || req.query.ok === 'false') filter.ok = req.query.ok === 'true';
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 30));
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const [rows, total] = await Promise.all([
    IntegrationLog.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).populate('actor', 'name email').lean(),
    IntegrationLog.countDocuments(filter),
  ]);
  res.json({ success: true, data: rows, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
});

// What can really be measured from here. Anything that cannot be measured is reported as "not measured", never as healthy.
exports.health = asyncHandler(async (req, res) => {
  let db = { ok: false, ms: null };
  try { const t = Date.now(); await mongoose.connection.db.admin().ping(); db = { ok: true, ms: Date.now() - t }; } catch { /* reported as down */ }
  const since = new Date(Date.now() - 24 * 3600 * 1000);
  const failed = await IntegrationLog.countDocuments({ ok: false, createdAt: { $gte: since } });
  const [email, smsView] = await Promise.all([integrations.view('email'), sanitizedSms()]);
  res.json({
    success: true,
    data: {
      checkedAt: new Date(),
      api: { ok: true, uptimeSeconds: Math.round(process.uptime()) },
      database: db,
      integrations: { email: stateOf('email', email), sms: stateOf('sms', smsView), failuresLast24h: failed },
      backgroundJobs: { disabledOnThisInstance: process.env.DISABLE_JOBS === 'true' },
      notMeasured: ['Backups and restore tests (no source of truth in the application)', 'Error rate (no metrics store is attached)', 'Payment, push and storage provider reachability'],
    },
  });
});
