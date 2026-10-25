// EduAmigo platform owner console: schools, plans, add-ons, subscriptions, usage and support access.
// Only users with role "superadmin" and a platform token reach these handlers (see routes/platformRoutes.js).
const mongoose = require('mongoose');
const School = require('../models/School');
const User = require('../models/User');
const Student = require('../models/Student');
const Plan = require('../models/Plan');
const AddOn = require('../models/AddOn');
const AuditLog = require('../models/AuditLog');
const UsageCounter = require('../models/UsageCounter');
const { signUserToken } = require('../services/tokens');
const { FEATURES, FEATURE_KEYS, SUBSCRIPTION_STATUSES } = require('../config/features');
const { HttpError, asyncHandler, assertId, escapeRegex } = require('../utils/http');
const sub = require('../services/subscription');
const { onboardSchool } = require('../services/schoolOnboarding');
const { clearDomainCache } = require('../services/schoolDirectory');
const { audit } = require('../services/audit');

const SUPPORT_TOKEN_TTL = '1h';

const platformToken = async (user) => {
  // Session length is a platform setting (1 to 24 hours); 12 hours when nothing is saved.
  let hours = 12;
  try { hours = (await require('./platformOpsController').readSettings()).sessionHours || 12; } catch { /* default */ }
  return signUserToken(user, { scope: 'platform', expiresIn: `${hours}h` });
};

// ---------------- Auth ----------------

// POST /api/platform/login
exports.login = asyncHandler(async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  if (!email || !password) throw new HttpError(400, 'Email and password are required');
  const user = await User.findOne({ email, role: 'superadmin' });
  const valid = user && (await user.comparePassword(password));
  if (!valid || !user.isActive) throw new HttpError(401, 'Invalid email or password');
  user.lastLoginAt = new Date();
  await user.save();
  req.platformUser = user;
  await audit(req, 'platform.login', { school: null });
  res.json({ success: true, token: await platformToken(user), user: { _id: user._id, name: user.name, email: user.email, role: 'superadmin' } });
});

// GET /api/platform/me
exports.me = asyncHandler(async (req, res) => {
  const u = req.platformUser;
  const pp = require('../config/platformPermissions');
  res.json({ success: true, data: { _id: u._id, name: u.name, email: u.email, role: 'superadmin', platformRole: pp.roleOf(u), permissions: pp.permissionsOf(u) } });
});

// ---------------- Catalogue ----------------

// GET /api/platform/catalog — features, plans and add-on prices in one call
exports.catalog = asyncHandler(async (req, res) => {
  const [plans, addOns] = await Promise.all([sub.allPlans({ fresh: true }), sub.allAddOns()]);
  res.json({
    success: true,
    data: {
      features: Object.entries(FEATURES).map(([key, f]) => ({ key, name: f.name, description: f.description, requires: f.requires || [] })),
      plans, addOns,
    },
  });
});

function numberOrNull(value, label) {
  if (value === null || value === '' || value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new HttpError(400, `${label} must be a positive number or empty`);
  return n;
}

function validFeatures(list, label = 'features') {
  if (list === undefined) return undefined;
  if (!Array.isArray(list)) throw new HttpError(400, `${label} must be a list`);
  const unknown = list.filter((f) => !FEATURE_KEYS.includes(f));
  if (unknown.length) throw new HttpError(400, `Unknown feature in ${label}: ${unknown.join(', ')}`);
  return [...new Set(list)];
}

// PUT /api/platform/plans/:code  { name, description, features, limits, pricePerStudentYear, isActive, sortOrder }
exports.savePlan = asyncHandler(async (req, res) => {
  const code = String(req.params.code || '').toLowerCase();
  if (!/^[a-z0-9_-]{2,30}$/.test(code)) throw new HttpError(400, 'Plan code must be 2-30 lowercase letters, digits, - or _');
  const body = req.body || {};
  const existing = await sub.findPlan(code);
  const name = String(body.name ?? existing?.name ?? '').trim();
  if (!name) throw new HttpError(400, 'Plan name is required');

  const doc = {
    code, name,
    description: String(body.description ?? existing?.description ?? '').trim(),
    features: validFeatures(body.features) ?? existing?.features ?? [],
    limits: {
      maxStudents: body.limits && 'maxStudents' in body.limits ? numberOrNull(body.limits.maxStudents, 'Max students') : (existing?.limits?.maxStudents ?? null),
      aiQuestionsPerMonth: body.limits && 'aiQuestionsPerMonth' in body.limits ? numberOrNull(body.limits.aiQuestionsPerMonth, 'AI questions per month') : (existing?.limits?.aiQuestionsPerMonth ?? null),
      aiBudgetPerMonth: body.limits && 'aiBudgetPerMonth' in body.limits ? numberOrNull(body.limits.aiBudgetPerMonth, 'AI budget per month') : (existing?.limits?.aiBudgetPerMonth ?? null),
      aiTokensPerMonth: body.limits && 'aiTokensPerMonth' in body.limits ? numberOrNull(body.limits.aiTokensPerMonth, 'AI tokens per month') : (existing?.limits?.aiTokensPerMonth ?? null),
      featureQuotas: Object.fromEntries(['ask', 'tutor', 'practice'].map((k) => [k, body.limits?.featureQuotas && k in body.limits.featureQuotas ? numberOrNull(body.limits.featureQuotas[k], `${k} quota`) : (existing?.limits?.featureQuotas?.[k] ?? null)])),
    },
    pricePerStudentYear: 'pricePerStudentYear' in body ? numberOrNull(body.pricePerStudentYear, 'Price') : (existing?.pricePerStudentYear ?? null),
    isActive: body.isActive !== undefined ? !!body.isActive : (existing?.isActive ?? true),
    sortOrder: body.sortOrder !== undefined ? Number(body.sortOrder) || 0 : (existing?.sortOrder ?? 0),
  };
  const plan = await Plan.findOneAndUpdate({ code }, doc, { upsert: true, returnDocument: 'after', runValidators: true });
  sub.clearPlanCache();
  await audit(req, 'platform.plan_saved', { school: null, targetType: 'plan', targetId: code, details: doc });
  res.json({ success: true, data: plan });
});

// PUT /api/platform/addons/:feature  { pricePerStudentYear, flatPricePerYear, isActive }
exports.saveAddOn = asyncHandler(async (req, res) => {
  const feature = req.params.feature;
  if (!FEATURES[feature]) throw new HttpError(404, 'Unknown feature');
  const body = req.body || {};
  const doc = {
    feature,
    pricePerStudentYear: numberOrNull(body.pricePerStudentYear, 'Price per student'),
    flatPricePerYear: numberOrNull(body.flatPricePerYear, 'Flat price'),
    isActive: body.isActive !== undefined ? !!body.isActive : true,
  };
  const addOn = await AddOn.findOneAndUpdate({ feature }, doc, { upsert: true, returnDocument: 'after', runValidators: true });
  await audit(req, 'platform.addon_saved', { school: null, targetType: 'addon', targetId: feature, details: doc });
  res.json({ success: true, data: addOn });
});

// ---------------- Schools ----------------

// Usage numbers for a set of schools, in a few grouped queries.
async function usageFor(schoolIds) {
  const ids = schoolIds.map((id) => new mongoose.Types.ObjectId(String(id)));
  const [students, users, ai] = await Promise.all([
    Student.aggregate([{ $match: { school: { $in: ids }, isActive: true } }, { $group: { _id: '$school', n: { $sum: 1 } } }]),
    User.aggregate([
      { $match: { school: { $in: ids } } },
      { $group: { _id: { school: '$school', role: '$role' }, n: { $sum: 1 }, lastLoginAt: { $max: '$lastLoginAt' } } },
    ]),
    UsageCounter.find({ school: { $in: ids }, metric: 'ai_questions', period: sub.monthKey() }).lean(),
  ]);
  const out = new Map(ids.map((id) => [String(id), { activeStudents: 0, users: {}, lastLoginAt: null, aiQuestionsThisMonth: 0 }]));
  for (const s of students) out.get(String(s._id)).activeStudents = s.n;
  for (const u of users) {
    const row = out.get(String(u._id.school));
    row.users[u._id.role] = u.n;
    if (u.lastLoginAt && (!row.lastLoginAt || u.lastLoginAt > row.lastLoginAt)) row.lastLoginAt = u.lastLoginAt;
  }
  for (const a of ai) out.get(String(a.school)).aiQuestionsThisMonth = a.count;
  return out;
}

async function schoolSummary(school, usage) {
  const e = await sub.entitlementsFor(school);
  return {
    _id: school._id, name: school.name, code: school.code, city: school.city, phone: school.phone, email: school.email,
    isActive: school.isActive, customDomain: school.customDomain || null, branding: school.branding,
    createdAt: school.createdAt,
    subscription: {
      plan: e.plan, addOns: school.subscription?.addOns || [],
      enabledFeatures: school.subscription?.enabledFeatures || [], disabledFeatures: school.subscription?.disabledFeatures || [],
      status: school.subscription?.status, trialEndsAt: school.subscription?.trialEndsAt || null,
      currentPeriodEnd: school.subscription?.currentPeriodEnd || null, graceDays: school.subscription?.graceDays,
      limitOverrides: school.subscription?.limits || {}, notes: school.subscription?.notes || '',
      discountPercent: school.subscription?.discountPercent || 0,
    },
    features: e.features, limits: e.limits, state: e.state,
    usage: usage || null,
  };
}

// GET /api/platform/schools?search=&state=trial|active|past_due|read_only|suspended&page=1&limit=25
exports.listSchools = asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));
  const filter = {};
  if (req.query.search) {
    const q = escapeRegex(String(req.query.search).trim());
    filter.$or = [{ name: { $regex: q, $options: 'i' } }, { code: { $regex: `^${q}`, $options: 'i' } }, { city: { $regex: q, $options: 'i' } }];
  }
  const schools = await School.find(filter).select('-payments').sort({ createdAt: -1 });
  // State is computed from dates, so it is filtered here rather than in the query (fine for hundreds of schools).
  let summaries = await Promise.all(schools.map((s) => schoolSummary(s)));
  if (req.query.state) summaries = summaries.filter((s) => s.state.status === req.query.state);
  const total = summaries.length;
  summaries = summaries.slice((page - 1) * limit, page * limit);
  const usage = await usageFor(summaries.map((s) => s._id));
  for (const s of summaries) s.usage = usage.get(String(s._id));
  res.json({ success: true, data: summaries, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
});

// GET /api/platform/stats — headline numbers for the owner dashboard
exports.stats = asyncHandler(async (req, res) => {
  const schools = await School.find({}).select('subscription isActive');
  const byState = {};
  for (const s of schools) {
    const st = sub.computeState(s).status;
    byState[st] = (byState[st] || 0) + 1;
  }
  const [activeStudents, users] = await Promise.all([
    Student.countDocuments({ isActive: true }),
    User.countDocuments({ role: { $ne: 'superadmin' } }),
  ]);
  res.json({ success: true, data: { schools: schools.length, byState, activeStudents, users } });
});

async function loadSchool(id) {
  assertId(id);
  const school = await School.findById(id).select('-payments');
  if (!school) throw new HttpError(404, 'School not found');
  return school;
}

// GET /api/platform/schools/:id
exports.getSchool = asyncHandler(async (req, res) => {
  const school = await loadSchool(req.params.id);
  const usage = await usageFor([school._id]);
  const admins = await User.find({ school: school._id, role: 'admin' }).select('name email phone isActive lastLoginAt');
  res.json({ success: true, data: { ...(await schoolSummary(school, usage.get(String(school._id)))), admins } });
});

// POST /api/platform/schools
// { name, code?, city?, address?, phone?, email?, adminName, adminEmail, plan?, addOns?, trialDays? }
exports.createSchool = asyncHandler(async (req, res) => {
  const { school, admin, password } = await onboardSchool(req.body || {});
  await audit(req, 'platform.school_created', {
    school: school._id, targetType: 'school', targetId: school._id,
    details: { name: school.name, code: school.code, plan: school.subscription.plan, admin: admin.email },
  });
  res.status(201).json({
    success: true,
    data: await schoolSummary(school),
    credentials: { email: admin.email, password },
  });
});

// PATCH /api/platform/schools/:id  { name, code, city, address, phone, email, principal, customDomain, branding, isActive }
exports.updateSchool = asyncHandler(async (req, res) => {
  const school = await loadSchool(req.params.id);
  const body = req.body || {};
  const before = { name: school.name, code: school.code, customDomain: school.customDomain, isActive: school.isActive };
  for (const key of ['name', 'city', 'address', 'phone', 'email', 'principal']) {
    if (body[key] !== undefined) school[key] = String(body[key]).trim();
  }
  if (body.code !== undefined) {
    const code = String(body.code).trim().toUpperCase();
    if (code !== school.code && await School.exists({ code })) throw new HttpError(409, `School code ${code} is already taken`);
    school.code = code;
  }
  if (body.customDomain !== undefined) school.customDomain = body.customDomain ? String(body.customDomain).trim().toLowerCase() : undefined;
  if (body.branding && typeof body.branding === 'object') {
    for (const key of ['appName', 'logoUrl', 'primaryColor', 'accentColor', 'tagline', 'heroStyle']) {
      if (body.branding[key] !== undefined) school.branding[key] = String(body.branding[key] || '').trim();
    }
  }
  if (body.isActive !== undefined) school.isActive = !!body.isActive;
  await school.save();
  clearDomainCache();
  await audit(req, 'platform.school_updated', {
    school: school._id, targetType: 'school', targetId: school._id,
    details: { before, after: { name: school.name, code: school.code, customDomain: school.customDomain, isActive: school.isActive } },
  });
  res.json({ success: true, data: await schoolSummary(school) });
});

// PATCH /api/platform/schools/:id/subscription
// { plan, addOns, enabledFeatures, disabledFeatures, limits: {maxStudents, aiQuestionsPerMonth},
//   status, trialEndsAt, currentPeriodEnd, graceDays, notes }
// Applies the requested subscription changes to a school document (validating them) without saving it.
async function applySubscription(school, body) {
  const s = school.subscription;
  if (body.plan !== undefined) {
    const plan = await sub.findPlan(String(body.plan).toLowerCase());
    if (!plan) throw new HttpError(400, `Unknown plan: ${body.plan}`);
    s.plan = plan.code;
  }
  for (const key of ['addOns', 'enabledFeatures', 'disabledFeatures']) {
    const list = validFeatures(body[key], key);
    if (list) s[key] = list;
  }
  if (body.limits && typeof body.limits === 'object') {
    if ('maxStudents' in body.limits) s.limits.maxStudents = numberOrNull(body.limits.maxStudents, 'Max students');
    if ('aiQuestionsPerMonth' in body.limits) s.limits.aiQuestionsPerMonth = numberOrNull(body.limits.aiQuestionsPerMonth, 'AI questions per month');
    if ('aiBudgetPerMonth' in body.limits) s.limits.aiBudgetPerMonth = numberOrNull(body.limits.aiBudgetPerMonth, 'AI budget per month');
    if ('aiTokensPerMonth' in body.limits) s.limits.aiTokensPerMonth = numberOrNull(body.limits.aiTokensPerMonth, 'AI tokens per month');
    for (const k of ['ask', 'tutor', 'practice']) {
      if (body.limits.featureQuotas && k in body.limits.featureQuotas) s.limits.featureQuotas[k] = numberOrNull(body.limits.featureQuotas[k], `${k} quota`);
    }
  }
  if (body.status !== undefined) {
    if (!SUBSCRIPTION_STATUSES.includes(body.status)) throw new HttpError(400, `Status must be one of: ${SUBSCRIPTION_STATUSES.join(', ')}`);
    s.status = body.status;
  }
  for (const key of ['trialEndsAt', 'currentPeriodEnd']) {
    if (body[key] === undefined) continue;
    if (body[key] === null || body[key] === '') { s[key] = null; continue; }
    const d = new Date(body[key]);
    if (Number.isNaN(d.getTime())) throw new HttpError(400, `${key} is not a valid date`);
    s[key] = d;
  }
  if (body.graceDays !== undefined) s.graceDays = Number(body.graceDays);
  if (body.discountPercent !== undefined) {
    const d = Number(body.discountPercent);
    if (!(d >= 0 && d <= 100)) throw new HttpError(400, 'Discount must be between 0 and 100');
    s.discountPercent = d;
  }
  if (body.notes !== undefined) s.notes = String(body.notes).slice(0, 1000);
  if (s.status === 'trial' && !s.trialEndsAt) throw new HttpError(400, 'A trial needs an end date');
}

exports.updateSubscription = asyncHandler(async (req, res) => {
  const school = await loadSchool(req.params.id);
  const before = school.toObject().subscription;
  await applySubscription(school, req.body || {});
  await school.save();
  await audit(req, 'platform.subscription_updated', {
    school: school._id, targetType: 'school', targetId: school._id,
    details: { before, after: school.toObject().subscription },
  });
  res.json({ success: true, data: await schoolSummary(school) });
});

// POST /api/platform/schools/:id/subscription/preview: what a change would do, without doing it.
exports.previewSubscription = asyncHandler(async (req, res) => {
  const school = await loadSchool(req.params.id);
  const eBefore = await sub.entitlementsFor(school);
  const planBefore = await sub.findPlan(school.subscription?.plan);
  await applySubscription(school, req.body || {});
  const eAfter = await sub.entitlementsFor(school);
  const planAfter = await sub.findPlan(school.subscription?.plan);
  const students = await Student.countDocuments({ school: school._id, isActive: true });
  const names = Object.fromEntries(Object.entries(FEATURES).map(([k, f]) => [k, f.name]));
  const added = eAfter.features.filter((f) => !eBefore.features.includes(f)).map((f) => names[f] || f);
  const removed = eBefore.features.filter((f) => !eAfter.features.includes(f)).map((f) => names[f] || f);
  const price = (plan, e) => (plan?.pricePerStudentYear != null ? Math.round(plan.pricePerStudentYear * students * (1 - (school.subscription?.discountPercent || 0) / 100)) : null);
  const warnings = [];
  if (eAfter.limits.maxStudents != null && students > eAfter.limits.maxStudents) warnings.push(`The school has ${students} active students, more than the new limit of ${eAfter.limits.maxStudents}. Nobody is removed, but new students cannot be added until the limit is raised.`);
  if (removed.length) warnings.push(`${removed.length} module${removed.length === 1 ? '' : 's'} will stop working for this school: ${removed.join(', ')}. Existing records are kept.`);
  if (eAfter.state.status !== eBefore.state.status) warnings.push(`The billing status changes from ${eBefore.state.status.replace('_', ' ')} to ${eAfter.state.status.replace('_', ' ')}.`);
  const pBefore = price(planBefore, eBefore); const pAfter = price(planAfter, eAfter);
  const direction = pBefore == null || pAfter == null ? (eBefore.plan.code === eAfter.plan.code ? 'same' : 'changed') : pAfter > pBefore ? 'upgrade' : pAfter < pBefore ? 'downgrade' : 'same';
  res.json({
    success: true,
    data: {
      school: { _id: school._id, name: school.name }, activeStudents: students, direction,
      plan: { from: eBefore.plan.name, to: eAfter.plan.name },
      status: { from: eBefore.state.status, to: eAfter.state.status },
      modules: { added, removed }, limits: { from: eBefore.limits, to: eAfter.limits },
      yearlyEstimate: { from: pBefore, to: pAfter, note: 'Active students x price per student per year, after the school discount. No charge is made and no invoice is created by changing a plan.' },
      warnings,
    },
  });
});

// POST /api/platform/schools/:id/support-session  { reason }
// Short-lived sign-in as the school's admin, to see what they see. Every change made with it is audited.
exports.supportSession = asyncHandler(async (req, res) => {
  const school = await loadSchool(req.params.id);
  const reason = String(req.body?.reason || '').trim();
  if (reason.length < 5) throw new HttpError(400, 'Please give a reason for the support session (for the audit log)');
  const admin = await User.findOne({ school: school._id, role: 'admin', isActive: true }).sort({ createdAt: 1 });
  if (!admin) throw new HttpError(404, 'This school has no active admin account');

  const token = signUserToken(admin, { imp: String(req.platformUser._id), expiresIn: SUPPORT_TOKEN_TTL });
  await audit(req, 'support.session_started', {
    school: school._id, targetType: 'user', targetId: admin._id, details: { reason, admin: admin.email },
  });
  res.json({ success: true, token, expiresIn: SUPPORT_TOKEN_TTL, actingAs: { name: admin.name, email: admin.email } });
});

// GET /api/platform/audit?school=&action=&page=&limit=
exports.auditLog = asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const filter = {};
  if (req.query.school) { assertId(req.query.school, 'school'); filter.school = req.query.school; }
  if (req.query.action) filter.action = String(req.query.action);
  const [rows, total] = await Promise.all([
    AuditLog.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit)
      .populate('actor', 'name email role').populate('school', 'name code').lean(),
    AuditLog.countDocuments(filter),
  ]);
  res.json({ success: true, data: rows, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
});

// ---------------- Billing ----------------

const Invoice = require('../models/Invoice');
const billing = require('../services/billing');
const { pageParams, paged } = require('../utils/paginate');

// GET /api/platform/schools/:id/invoice-preview?from=2026-04-01&to=2027-03-31
exports.previewInvoice = asyncHandler(async (req, res) => {
  const school = await loadSchool(req.params.id);
  res.json({ success: true, data: await billing.computeInvoice(school, { from: req.query.from, to: req.query.to }) });
});

// POST /api/platform/schools/:id/invoices { from, to, dueDate?, notes?, issue? }
exports.createInvoice = asyncHandler(async (req, res) => {
  const school = await loadSchool(req.params.id);
  const { invoice, warnings } = await billing.createInvoice(school, { ...(req.body || {}), createdBy: req.platformUser._id });
  await audit(req, 'platform.invoice_created', { school: school._id, targetType: 'invoice', targetId: invoice._id, details: { number: invoice.number, total: invoice.total, status: invoice.status } });
  res.status(201).json({ success: true, data: invoice, warnings });
});

// GET /api/platform/invoices?status=&school=&page=&limit=
exports.listInvoices = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.status) filter.status = String(req.query.status);
  if (req.query.school) { assertId(req.query.school, 'school'); filter.school = req.query.school; }
  const paging = pageParams({ page: req.query.page || 1, limit: req.query.limit || 50 });
  const result = await paged(Invoice, filter, paging, (q) => q.sort({ createdAt: -1 }).populate('school', 'name code').lean());
  const totals = await Invoice.aggregate([{ $match: { ...filter, ...(filter.school ? { school: new mongoose.Types.ObjectId(String(filter.school)) } : {}) } },
    { $group: { _id: '$status', count: { $sum: 1 }, total: { $sum: '$total' } } }]);
  res.json({ success: true, ...result, totals: Object.fromEntries(totals.map((t) => [t._id, { count: t.count, total: Math.round(t.total * 100) / 100 }])) });
});

// GET /api/platform/invoices/:id
exports.getInvoice = asyncHandler(async (req, res) => {
  assertId(req.params.id);
  const invoice = await Invoice.findById(req.params.id).populate('school', 'name code address city email phone');
  if (!invoice) throw new HttpError(404, 'Invoice not found');
  res.json({ success: true, data: invoice });
});

// PATCH /api/platform/invoices/:id { action: "issue" | "mark_paid" | "void", paymentRef? }
exports.updateInvoice = asyncHandler(async (req, res) => {
  assertId(req.params.id);
  const invoice = await Invoice.findById(req.params.id);
  if (!invoice) throw new HttpError(404, 'Invoice not found');
  const action = String(req.body?.action || '');
  await billing.changeStatus(invoice, action, { paymentRef: req.body?.paymentRef });
  await audit(req, `platform.invoice_${action}`, { school: invoice.school, targetType: 'invoice', targetId: invoice._id, details: { number: invoice.number, paymentRef: invoice.paymentRef } });
  res.json({ success: true, data: invoice });
});

