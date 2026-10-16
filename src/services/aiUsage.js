// AI usage: who used which AI feature, how much it cost to run, and the limits that stop paid calls.
//
// Principles
//  - Nothing here calls a provider. A school with no AI use has no rows and pays no variable AI cost.
//  - Every provider call (and every cache hit that avoided one) writes one AiUsage row, attributed to the school and the feature
//    that were set around it with `within()`. llm.js and services/ai.js do the recording; features only set the context.
//  - Token counts are the provider's when it reports them; otherwise they are estimated (characters / 4) and flagged.
//  - The cost is an internal estimate (tokens x the price in AI_PRICING). Without a price it is null, never a guess. The
//    provider's actual bill is a different number that only the provider can give (Azure Cost Management / the OpenAI and Google
//    consoles); this service does not read it, and the summary says so.
//  - Limits are per school and per month: the plan's questions allowance (counted elsewhere), a cost budget, a token budget and
//    quotas per feature. At a hard limit paid calls stop (the tutor and practice answer 429 with the reason; Ask falls back to
//    its keyword mode, which makes no model call). Provider-side spend limits are a separate, second control.

const { AsyncLocalStorage } = require('async_hooks');
const mongoose = require('mongoose');
const AiUsage = require('../models/AiUsage');
const pricing = require('./aiPricing');
const { HttpError } = require('../utils/http');

const storage = new AsyncLocalStorage();
const pending = new Set();

const WARN_AT = () => Math.min(0.99, Math.max(0.1, Number(process.env.AI_WARN_AT || 0.8)));
const periodOf = (d = new Date()) => d.toISOString().slice(0, 7);

// Quotas count what a person asked for, not the helper calls behind it.
const QUOTA_GROUPS = { ask: ['ask'], tutor: ['tutor'], practice: ['practice', 'practice_mark'] };
const FEATURE_LABELS = {
  ask: 'EduAmigo Ask', tutor: 'AI Tutor', tutor_verify: 'Tutor calculation check', practice: 'Practice questions',
  practice_verify: 'Practice answer-key check', practice_mark: 'Practice marking', voice_out: 'Spoken answers (natural voice)', embeddings: 'Notes search index', revision_legacy: 'Revise with AI (old)',
};

// Runs fn with a school and feature attached, so every model call inside is recorded against them.
const within = (ctx, fn) => storage.run({ school: ctx.school ? String(ctx.school) : null, user: ctx.user ? String(ctx.user) : null, feature: ctx.feature, voice: !!ctx.voice }, fn);
const current = () => storage.getStore() || null;

const roughTokens = (text) => Math.ceil(String(text || '').length / 4);

// Records one call. Never throws and never waits for the database: an answer must not fail because accounting did.
function record(entry) {
  const ctx = current();
  const school = entry.school || ctx?.school;
  if (!school) return;
  const feature = entry.feature || ctx?.feature || 'unknown';
  const inputTokens = Math.max(0, Math.round(entry.inputTokens || 0));
  const outputTokens = Math.max(0, Math.round(entry.outputTokens || 0));
  const { cost, currency } = entry.cached || !entry.provider ? { cost: entry.cached ? 0 : null, currency: null } : pricing.estimate(entry.provider, entry.model, inputTokens, outputTokens);
  const row = {
    school, user: entry.user || ctx?.user || null, period: periodOf(), feature, provider: entry.cached ? null : entry.provider || null, model: entry.cached ? null : entry.model || null,
    inputTokens, outputTokens, tokensEstimated: !!entry.estimated, voice: !!(entry.voice ?? ctx?.voice), cached: !!entry.cached, ok: entry.ok !== false, ms: Math.round(entry.ms || 0),
    costEstimate: cost, currency, at: new Date(),
  };
  const p = AiUsage.create(row).catch((err) => { if (process.env.NODE_ENV !== 'test') console.error(`[ai-usage] could not record: ${err.message}`); });
  pending.add(p);
  p.finally(() => pending.delete(p));
}

// Waits for rows that are still being written (before reading totals, and in tests).
const flush = () => Promise.all([...pending]);

// ---- totals, limits, alerts ----
async function totals(schoolId, period = periodOf()) {
  await flush();
  const rows = await AiUsage.aggregate([
    { $match: { school: new mongoose.Types.ObjectId(String(schoolId)), period } },
    { $group: {
      _id: '$feature', calls: { $sum: { $cond: [{ $or: ['$cached', { $eq: ['$ok', false] }] }, 0, 1] } }, failed: { $sum: { $cond: [{ $eq: ['$ok', false] }, 1, 0] } },
      cacheHits: { $sum: { $cond: ['$cached', 1, 0] } }, input: { $sum: '$inputTokens' }, output: { $sum: '$outputTokens' },
      estimatedCalls: { $sum: { $cond: ['$tokensEstimated', 1, 0] } }, cost: { $sum: { $ifNull: ['$costEstimate', 0] } }, unpriced: { $sum: { $cond: [{ $and: [{ $eq: ['$costEstimate', null] }, { $not: ['$cached'] }, '$ok'] }, 1, 0] } },
      voice: { $sum: { $cond: ['$voice', 1, 0] } }, audioSeconds: { $sum: '$audioSeconds' }, currency: { $max: '$currency' },
    } },
  ]);
  const byFeature = {};
  const all = { calls: 0, failed: 0, cacheHits: 0, inputTokens: 0, outputTokens: 0, tokens: 0, costEstimate: 0, unpricedCalls: 0, estimatedTokenCalls: 0, voiceRequests: 0, audioSeconds: 0, currency: null };
  for (const r of rows) {
    byFeature[r._id] = { feature: r._id, label: FEATURE_LABELS[r._id] || r._id, calls: r.calls, failed: r.failed, cacheHits: r.cacheHits, inputTokens: r.input, outputTokens: r.output, costEstimate: r.cost, unpricedCalls: r.unpriced };
    all.calls += r.calls; all.failed += r.failed; all.cacheHits += r.cacheHits; all.inputTokens += r.input; all.outputTokens += r.output; all.costEstimate += r.cost;
    all.unpricedCalls += r.unpriced; all.estimatedTokenCalls += r.estimatedCalls; all.voiceRequests += r.voice; all.audioSeconds += r.audioSeconds; all.currency = all.currency || r.currency;
  }
  all.tokens = all.inputTokens + all.outputTokens;
  all.costEstimate = Math.round(all.costEstimate * 1e6) / 1e6;
  const asked = (group) => QUOTA_GROUPS[group].reduce((n, f) => n + (byFeature[f]?.calls || 0), 0);
  return { period, all, byFeature, asked: { ask: asked('ask'), tutor: asked('tutor'), practice: asked('practice') } };
}

// Every configured limit with its usage and state: ok | warning | exhausted | unenforceable.
function evaluate(t, limits = {}) {
  const warn = WARN_AT();
  const rows = [];
  const add = (key, label, used, limit, unit, extra = {}) => {
    if (limit == null) return;
    const ratio = limit > 0 ? used / limit : 1;
    rows.push({ key, label, used, limit, unit, ratio: Math.round(ratio * 1000) / 1000, state: used >= limit ? 'exhausted' : ratio >= warn ? 'warning' : 'ok', ...extra });
  };
  if (limits.aiBudgetPerMonth != null) {
    const priced = pricing.status().configured && t.all.unpricedCalls === 0;
    if (!pricing.status().configured) rows.push({ key: 'budget', label: 'Monthly AI cost budget', limit: limits.aiBudgetPerMonth, used: null, unit: 'cost', state: 'unenforceable', note: 'No model price is configured (AI_PRICING), so the cost cannot be estimated and this budget is not enforced. Use the token limit, or configure prices.' });
    else add('budget', 'Monthly AI cost budget', t.all.costEstimate, limits.aiBudgetPerMonth, t.all.currency || pricing.status().currency, priced ? {} : { note: `${t.all.unpricedCalls} call(s) used a model with no configured price and are not counted.` });
  }
  add('tokens', 'Monthly AI tokens', t.all.tokens, limits.aiTokensPerMonth, 'tokens');
  for (const g of Object.keys(QUOTA_GROUPS)) add(`quota_${g}`, `${FEATURE_LABELS[g] || g} per month`, t.asked[g], limits.featureQuotas?.[g], 'requests', { group: g });
  return rows;
}

// Hard limits that apply to a feature group. `group`: ask | tutor | practice | null (anything that is not user-facing).
function blocking(rows, group) {
  return rows.find((r) => r.state === 'exhausted' && (r.key === 'budget' || r.key === 'tokens' || r.group === group));
}

const messageFor = (r) => (r.key === 'budget' ? "Your school's monthly AI budget has been used. AI answers are paused until next month or until the school raises the limit."
  : r.key === 'tokens' ? "Your school's monthly AI allowance has been used. AI answers are paused until next month or until the school raises the limit."
    : `Your school's monthly limit for ${r.label.replace(/ per month$/, '')} has been reached. It resets next month or when the school raises the limit.`);

// Throws 429 (code AI_LIMIT) when a paid call must not start. The message is written for the person.
async function assertAllowed({ schoolId, entitlements, group }) {
  const t = await totals(schoolId);
  const hit = blocking(evaluate(t, entitlements?.limits), group);
  if (hit) throw Object.assign(new HttpError(429, messageFor(hit), { code: 'AI_LIMIT', limit: hit.key }), { expose: true });
  return t;
}
// True when a paid call may start (used by Ask, which falls back to keywords instead of failing).
async function isAllowed({ schoolId, entitlements, group }) {
  try { await assertAllowed({ schoolId, entitlements, group }); return true; } catch (err) { if (err.extra?.code === 'AI_LIMIT') return false; throw err; }
}

// ---- one answer at a time per person ----
const inflight = new Map();
const MAX_CONCURRENT = () => Number(process.env.AI_MAX_CONCURRENT_PER_USER || 1);
function acquire(userId, kind = 'ai') {
  const key = `${userId}:${kind}`;
  const n = inflight.get(key) || 0;
  if (n >= MAX_CONCURRENT()) throw Object.assign(new HttpError(429, 'Please wait for the current answer to finish before asking again.', { code: 'AI_BUSY' }), { expose: true });
  inflight.set(key, n + 1);
  let released = false;
  return () => { if (released) return; released = true; const c = (inflight.get(key) || 1) - 1; if (c <= 0) inflight.delete(key); else inflight.set(key, c); };
}

// The school admin's summary. `limits` from the school's entitlements.
async function summary(schoolId, entitlements, period = periodOf()) {
  const t = await totals(schoolId, period);
  const limits = entitlements?.limits || {};
  const rows = evaluate(t, limits);
  const price = pricing.status();
  const legacy = limits.aiQuestionsPerMonth;
  return {
    period,
    totals: t.all,
    byFeature: Object.values(t.byFeature).sort((a, b) => b.calls - a.calls),
    limits: rows,
    questionsAllowance: legacy == null ? null : { limit: legacy },
    alerts: rows.filter((r) => r.state !== 'ok').map((r) => ({ key: r.key, level: r.state === 'warning' ? 'warning' : r.state === 'exhausted' ? 'critical' : 'info', message: r.state === 'exhausted' ? messageFor(r) : r.state === 'warning' ? `${r.label}: ${Math.round(r.ratio * 100)}% used.` : r.note })),
    cost: {
      kind: 'estimate',
      note: 'Estimated from tokens x the prices configured for this deployment. It is not the provider\'s invoice; check the provider\'s billing portal for the actual charge.',
      pricesConfigured: price.configured, currency: price.currency, estimated: price.configured ? t.all.costEstimate : null, unpricedCalls: t.all.unpricedCalls,
      tokensReportedByProvider: t.all.calls - t.all.estimatedTokenCalls, tokensEstimatedCalls: t.all.estimatedTokenCalls,
      actualProviderBilling: null,
    },
    voice: { requests: t.all.voiceRequests, providerBilledSeconds: t.all.audioSeconds, note: 'Spoken questions use the browser\'s own speech service; no provider-billed voice session is configured.' },
    zeroUse: t.all.calls === 0 && t.all.cacheHits === 0,
  };
}

const resetForTests = () => { inflight.clear(); pending.clear(); };

module.exports = { within, current, record, flush, totals, evaluate, blocking, assertAllowed, isAllowed, acquire, summary, roughTokens, periodOf, resetForTests, QUOTA_GROUPS, FEATURE_LABELS };
