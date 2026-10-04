// EduAmigo Ask metrics for a school, from the query log (PS18: "measure routing accuracy and
// true end-to-end resolution").
//
// Resolution (per question that got an answer): answered, not handed off, not marked unhelpful, and the
// same person did not ask about the same topic again within 10 minutes. A repeat means the first answer
// did not settle it.
//
// Routing accuracy needs labelled questions, so it comes from the evaluation set (eval.js); live traffic
// adds the clarify rate, hand-off rate, feedback and speed.

const AssistantQuery = require('../models/AssistantQuery');
const AssistantTicket = require('../models/AssistantTicket');
const { DOMAINS } = require('./domains');

const REPEAT_WINDOW_MS = 10 * 60 * 1000;
const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : 0);

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

async function schoolMetrics(schoolId, { days = 30, now = new Date() } = {}) {
  const since = new Date(now.getTime() - days * 86400000);
  const rows = await AssistantQuery.find({ school: schoolId, createdAt: { $gte: since } }).sort({ createdAt: 1 }).limit(20000).lean();

  const parts = rows.flatMap((r) => r.parts.map((p) => ({ ...p, query: r })));
  const byAction = { answer: 0, clarify: 0, handoff: 0, blocked: 0, no_data: 0 };
  parts.forEach((p) => { byAction[p.action] = (byAction[p.action] || 0) + 1; });

  const byDomain = {};
  for (const p of parts) {
    if (!p.domain || !DOMAINS[p.domain]) continue;
    const d = byDomain[p.domain] || { domain: p.domain, label: DOMAINS[p.domain].label, questions: 0, answered: 0, clarified: 0, handedOff: 0, avgConfidence: 0 };
    d.questions += 1;
    if (p.action === 'answer') d.answered += 1;
    if (p.action === 'clarify') d.clarified += 1;
    if (p.action === 'handoff') d.handedOff += 1;
    d.avgConfidence += p.confidence || 0;
    byDomain[p.domain] = d;
  }
  Object.values(byDomain).forEach((d) => { d.avgConfidence = Math.round((d.avgConfidence / d.questions) * 100) / 100; });

  // Resolution over answered parts.
  const answered = parts.filter((p) => p.action === 'answer' && p.domain && p.domain !== 'general');
  const byUser = new Map(); // user -> that user's queries, oldest first
  rows.forEach((r) => { const k = String(r.user); if (!byUser.has(k)) byUser.set(k, []); byUser.get(k).push(r); });
  let resolved = 0;
  for (const p of answered) {
    const q = p.query;
    if (q.feedback?.helpful === false) continue;
    const t = new Date(q.createdAt).getTime();
    const mine = byUser.get(String(q.user));
    let repeat = false;
    for (let i = mine.indexOf(q) + 1; i < mine.length; i += 1) {
      const o = mine[i];
      if (new Date(o.createdAt).getTime() - t > REPEAT_WINDOW_MS) break;
      if (o.parts.some((x) => x.domain === p.domain && x.method !== 'choice')) { repeat = true; break; }
    }
    if (!repeat) resolved += 1;
  }

  const methods = {};
  parts.forEach((p) => { methods[p.method] = (methods[p.method] || 0) + 1; });
  const latencies = rows.map((r) => r.latencyMs || 0);
  const helpful = rows.filter((r) => r.feedback?.helpful === true).length;
  const unhelpful = rows.filter((r) => r.feedback?.helpful === false).length;
  const ai = rows.filter((r) => r.ai?.used);
  const answeredWithSources = answered.filter((p) => p.sources > 0).length;

  const unclear = parts.filter((p) => ['clarify', 'no_data', 'handoff'].includes(p.action) && p.text)
    .slice(-200).reduce((m, p) => { const k = p.text.toLowerCase().trim(); m.set(k, (m.get(k) || 0) + 1); return m; }, new Map());

  const tickets = await AssistantTicket.aggregate([
    { $match: { school: schoolId, createdAt: { $gte: since } } },
    { $group: { _id: '$status', n: { $sum: 1 } } },
  ]);

  return {
    period: { days, from: since, to: now },
    questions: rows.length,
    parts: parts.length,
    actions: byAction,
    rates: {
      answered: pct(byAction.answer, parts.length),
      clarify: pct(byAction.clarify, parts.length),
      handoff: pct(byAction.handoff, parts.length),
      resolution: pct(resolved, answered.length),
      sourceCitation: pct(answeredWithSources, answered.length),
      helpful: pct(helpful, helpful + unhelpful),
    },
    resolution: { answered: answered.length, resolved },
    feedback: { helpful, unhelpful },
    routing: { methods, keywordOnly: pct(methods.keywords || 0, parts.length) },
    speed: { p50: percentile(latencies, 50), p95: percentile(latencies, 95) },
    ai: { questions: ai.length, share: pct(ai.length, rows.length), inputTokens: ai.reduce((s, r) => s + (r.ai.inputTokens || 0), 0), outputTokens: ai.reduce((s, r) => s + (r.ai.outputTokens || 0), 0), rewritten: rows.filter((r) => r.ai?.rewritten).length },
    domains: Object.values(byDomain).sort((a, b) => b.questions - a.questions),
    needsAttention: [...unclear.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([text, count]) => ({ text, count })),
    tickets: Object.fromEntries(tickets.map((t) => [t._id, t.n])),
  };
}

module.exports = { schoolMetrics, REPEAT_WINDOW_MS };
