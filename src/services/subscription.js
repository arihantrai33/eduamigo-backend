// What a school is entitled to right now: its features, limits and billing state.
//
//   features = plan.features + subscription.addOns + subscription.enabledFeatures - subscription.disabledFeatures
//              (a feature whose prerequisite is missing is dropped, e.g. online payments without fees)
//   limits   = plan.limits, overridden per school
//   state    = computed from status and dates (no cron needed):
//       trial / active          everything works
//       past_due                trial or paid period ended; full access during the grace period, apps show a warning
//       read_only               grace period over (or set by hand): data can be viewed, nothing can be changed
//       suspended               no access (set by the platform owner, or school.isActive = false)

const Plan = require('../models/Plan');
const AddOn = require('../models/AddOn');
const School = require('../models/School');
const UsageCounter = require('../models/UsageCounter');
const { FEATURES, DEFAULT_PLANS, DEFAULT_GRACE_DAYS } = require('../config/features');
const { HttpError } = require('../utils/http');

const DAY = 86400000;
const CACHE_MS = 60 * 1000;
let planCache = { at: 0, plans: null };

const defaultPlan = (code) => DEFAULT_PLANS.find((p) => p.code === code);

// Database plans merged over the built-in defaults, cached for a minute.
async function allPlans({ fresh = false } = {}) {
  if (!fresh && planCache.plans && Date.now() - planCache.at < CACHE_MS) return planCache.plans;
  const saved = await Plan.find({}).lean();
  const byCode = new Map(DEFAULT_PLANS.map((p) => [p.code, { ...p, isActive: true, builtIn: true }]));
  for (const p of saved) byCode.set(p.code, { ...p, builtIn: !!defaultPlan(p.code) });
  const plans = [...byCode.values()].sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
  planCache = { at: Date.now(), plans };
  return plans;
}

function clearPlanCache() {
  planCache = { at: 0, plans: null };
}

async function findPlan(code) {
  const plans = await allPlans();
  return plans.find((p) => p.code === code) || null;
}

async function allAddOns() {
  const saved = await AddOn.find({}).lean();
  const byFeature = new Map(saved.map((a) => [a.feature, a]));
  return Object.entries(FEATURES).map(([feature, meta]) => ({
    feature, name: meta.name, description: meta.description, requires: meta.requires || [],
    pricePerStudentYear: byFeature.get(feature)?.pricePerStudentYear ?? null,
    flatPricePerYear: byFeature.get(feature)?.flatPricePerYear ?? null,
    isActive: byFeature.get(feature)?.isActive ?? true,
  }));
}

function resolveFeatures(plan, sub = {}) {
  const set = new Set([...(plan?.features || []), ...(sub.addOns || []), ...(sub.enabledFeatures || [])]);
  for (const f of sub.disabledFeatures || []) set.delete(f);
  // Drop features whose prerequisites are missing.
  for (const f of [...set]) {
    if ((FEATURES[f]?.requires || []).some((r) => !set.has(r))) set.delete(f);
  }
  return [...set].filter((f) => FEATURES[f]).sort();
}

function resolveLimits(plan, sub = {}) {
  const pick = (key) => (sub.limits?.[key] != null ? sub.limits[key] : (plan?.limits?.[key] ?? null));
  return { maxStudents: pick('maxStudents'), aiQuestionsPerMonth: pick('aiQuestionsPerMonth') };
}

// Billing state from status and dates.
function computeState(school, now = new Date()) {
  const sub = school.subscription || {};
  const graceDays = sub.graceDays ?? DEFAULT_GRACE_DAYS;
  if (school.isActive === false || sub.status === 'suspended') return { status: 'suspended', endsAt: null, daysLeft: 0 };
  if (sub.status === 'read_only') return { status: 'read_only', endsAt: null, daysLeft: 0 };

  const endsAt = sub.status === 'trial' ? sub.trialEndsAt : sub.currentPeriodEnd;
  const base = sub.status === 'trial' ? 'trial' : 'active';
  if (!endsAt) return { status: base, endsAt: null, daysLeft: null };

  const end = new Date(endsAt).getTime();
  if (now.getTime() <= end) return { status: base, endsAt: new Date(end), daysLeft: Math.ceil((end - now.getTime()) / DAY) };
  const graceEnd = end + graceDays * DAY;
  if (now.getTime() <= graceEnd) {
    return { status: 'past_due', endsAt: new Date(end), graceEndsAt: new Date(graceEnd), daysLeft: Math.ceil((graceEnd - now.getTime()) / DAY) };
  }
  return { status: 'read_only', endsAt: new Date(end), daysLeft: 0 };
}

async function entitlementsFor(school, now = new Date()) {
  const sub = school.subscription || {};
  const plan = (await findPlan(sub.plan)) || defaultPlan('basic');
  const state = computeState(school, now);
  return {
    plan: { code: plan.code, name: plan.name },
    features: resolveFeatures(plan, sub),
    limits: resolveLimits(plan, sub),
    state,
    readOnly: state.status === 'read_only',
    blocked: state.status === 'suspended',
  };
}

const hasFeature = (entitlements, feature) => !!entitlements?.features.includes(feature);

// School ids that may use a feature right now (not suspended or read-only). Used by background jobs.
async function schoolIdsWithFeature(feature) {
  const schools = await School.find({}).select('subscription isActive');
  const ids = [];
  for (const school of schools) {
    const e = await entitlementsFor(school);
    if (!e.blocked && !e.readOnly && hasFeature(e, feature)) ids.push(school._id);
  }
  return ids;
}

const monthKey = (now = new Date()) => now.toISOString().slice(0, 7);

async function usageThisMonth(schoolId, metric, now = new Date()) {
  const row = await UsageCounter.findOne({ school: schoolId, metric, period: monthKey(now) }).lean();
  return row?.count || 0;
}

async function recordUsage(schoolId, metric, n = 1, now = new Date()) {
  await UsageCounter.updateOne({ school: schoolId, metric, period: monthKey(now) }, { $inc: { count: n } }, { upsert: true });
}

// Throws 403 when adding `adding` more active students would pass the plan's limit.
async function assertStudentCapacity(schoolId, adding = 1) {
  const school = await School.findById(schoolId).select('subscription isActive');
  if (!school) return;
  const { limits } = await entitlementsFor(school);
  if (limits.maxStudents == null) return;
  const Student = require('../models/Student');
  const active = await Student.countDocuments({ school: schoolId, isActive: true });
  if (active + adding > limits.maxStudents) {
    throw new HttpError(403, `Your plan allows ${limits.maxStudents} active students. Please upgrade your plan to add more.`, { code: 'PLAN_LIMIT' });
  }
}

module.exports = {
  allPlans, findPlan, allAddOns, clearPlanCache, resolveFeatures, resolveLimits, computeState,
  entitlementsFor, hasFeature, schoolIdsWithFeature, usageThisMonth, recordUsage, assertStudentCapacity, monthKey,
};
