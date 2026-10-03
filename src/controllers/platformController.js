// EduAmigo platform owner console: schools, plans, add-ons, subscriptions, usage and support access.
// Only users with role "superadmin" and a platform token reach these handlers (see routes/platformRoutes.js).
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const School = require('../models/School');
const User = require('../models/User');
const Student = require('../models/Student');
const Plan = require('../models/Plan');
const AddOn = require('../models/AddOn');
const AuditLog = require('../models/AuditLog');
const UsageCounter = require('../models/UsageCounter');
const { jwtSecret } = require('../config/env');
const { FEATURES, FEATURE_KEYS, SUBSCRIPTION_STATUSES } = require('../config/features');
const { HttpError, asyncHandler, assertId, escapeRegex } = require('../utils/http');
const sub = require('../services/subscription');
const { onboardSchool } = require('../services/schoolOnboarding');
const { clearDomainCache } = require('../services/schoolDirectory');
const { audit } = require('../services/audit');

const PLATFORM_TOKEN_TTL = '12h';
const SUPPORT_TOKEN_TTL = '1h';

const platformToken = (user) => jwt.sign({ id: user._id, role: 'superadmin', scope: 'platform' }, jwtSecret(), { expiresIn: PLATFORM_TOKEN_TTL });

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
  res.json({ success: true, token: platformToken(user), user: { _id: user._id, name: user.name, email: user.email, role: 'superadmin' } });
});

// GET /api/platform/me
exports.me = asyncHandler(async (req, res) => {
  const u = req.platformUser;
  res.json({ success: true, data: { _id: u._id, name: u.name, email: u.email, role: 'superadmin' } });
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
    for (const key of ['appName', 'logoUrl', 'primaryColor', 'tagline']) {
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
exports.updateSubscription = asyncHandler(async (req, res) => {
  const school = await loadSchool(req.params.id);
  const body = req.body || {};
  const s = school.subscription;
  const before = school.toObject().subscription;

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
  if (body.notes !== undefined) s.notes = String(body.notes).slice(0, 1000);
  if (s.status === 'trial' && !s.trialEndsAt) throw new HttpError(400, 'A trial needs an end date');

  await school.save();
  await audit(req, 'platform.subscription_updated', {
    school: school._id, targetType: 'school', targetId: school._id,
    details: { before, after: school.toObject().subscription },
  });
  res.json({ success: true, data: await schoolSummary(school) });
});

// POST /api/platform/schools/:id/support-session  { reason }
// Short-lived sign-in as the school's admin, to see what they see. Every change made with it is audited.
exports.supportSession = asyncHandler(async (req, res) => {
  const school = await loadSchool(req.params.id);
  const reason = String(req.body?.reason || '').trim();
  if (reason.length < 5) throw new HttpError(400, 'Please give a reason for the support session (for the audit log)');
  const admin = await User.findOne({ school: school._id, role: 'admin', isActive: true }).sort({ createdAt: 1 });
  if (!admin) throw new HttpError(404, 'This school has no active admin account');

  const token = jwt.sign({ id: admin._id, role: 'admin', imp: String(req.platformUser._id) }, jwtSecret(), { expiresIn: SUPPORT_TOKEN_TTL });
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
