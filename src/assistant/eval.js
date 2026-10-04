// Routing evaluation for EduAmigo Ask (PS18: "measure routing accuracy").
//
// Runs every labelled question in eval/questions.json through the same splitter, router and confidence
// gate the live assistant uses (no database needed) and reports:
//   routing accuracy   - the topic(s) found equal the expected topic(s)
//   action accuracy    - answer / clarify / hand-off chosen correctly
//   per-topic precision, recall and F1, and a confusion matrix
// separately for the dev split (may be used to improve keyword lists), the holdout split (never tuned on) and
// the unseen split (written afterwards in new styles and spellings; never used to add keywords).
//
// Keyword mode (default) skips questions marked needsModel; model mode (useModel) includes them and calls
// the configured language model for low-confidence questions.

const { DOMAINS, domainsForRole } = require('./domains');
const router = require('./router');
const questions = require('./eval/questions.json');

const GENERAL_ROUTES = new Set(['general', null]);

// What the live assistant would do with a message, at routing level.
async function predictWithModel(item, allowed) {
  const u = await router.understand(item.q, { role: item.role, allowed });
  if (!u) return null;
  const domains = [];
  let action = 'answer';
  let minConfidence = 1;
  for (const part of u.parts) {
    if (part.urgent || part.kind === 'complaint' || part.kind === 'human') {
      return { domains: [DOMAINS[part.topic] && part.topic !== 'general' ? part.topic : null], action: 'handoff', confidence: part.confidence };
    }
    if (part.kind === 'complaint_inquiry') { domains.push('general'); continue; }
    const r = router.reconcile(part, allowed);
    // Same as the live assistant: a topic this person cannot use becomes a school question, unless the words name it.
    const topic = DOMAINS[r.domain] && r.domain !== 'general' && !allowed.includes(r.domain) && r.method === 'model' && !router.wordsNameTopic(part.text, r.domain) ? 'school_other' : r.domain;
    domains.push(topic);
    minConfidence = Math.min(minConfidence, r.confidence);
    if (DOMAINS[topic] && topic !== 'general' && r.confidence < router.ANSWER_AT) {
      action = 'clarify';
      if (r.runnerUp && r.confidence >= router.CLARIFY_AT) domains.push(r.runnerUp);
    }
  }
  return { domains: [...new Set(domains)], action, confidence: minConfidence };
}

async function predict(item, { useModel = false } = {}) {
  const allowed = domainsForRole(item.role);
  // Same order as the live assistant: safety words first, then the model reads the message, words are the fallback.
  if (useModel && !router.isSevere(item.q)) {
    const viaModel = await predictWithModel(item, allowed);
    if (viaModel) return viaModel;
  }
  if (router.isSensitive(item.q) || router.wantsHuman(item.q)) {
    const s = router.scoreKeywords(item.q, allowed);
    return { domains: [s.domain && s.domain !== 'general' ? s.domain : null], action: 'handoff', confidence: 1 };
  }
  const parts = router.splitQuestions(item.q, allowed).slice(0, 4);
  const domains = [];
  let action = 'answer';
  let minConfidence = 1;
  for (const p of parts) {
    const r = await router.route(p, { role: item.role, allowed, useModel });
    if (r.sensitive) return { domains: [r.domain], action: 'handoff', confidence: r.confidence };
    const d = r.domain || 'general';
    domains.push(d);
    minConfidence = Math.min(minConfidence, r.domain ? r.confidence : 1);
    if (r.domain && r.domain !== 'general' && r.domain !== 'school_other' && r.confidence < router.ANSWER_AT) {
      action = 'clarify';
      if (r.runnerUp && r.confidence >= router.CLARIFY_AT) domains.push(r.runnerUp);
    }
  }
  return { domains: [...new Set(domains)], action, confidence: minConfidence };
}

const asList = (e) => (Array.isArray(e) ? e : [e]);

function domainCorrect(item, pred) {
  const expected = asList(item.expect);
  if (item.action === 'handoff') return true; // hand-offs are judged on the action; the topic only picks the team
  if (expected.length === 1 && GENERAL_ROUTES.has(expected[0])) return pred.domains.every((d) => GENERAL_ROUTES.has(d));
  if (item.action === 'clarify') return pred.domains.some((d) => expected.includes(d));
  return expected.length === pred.domains.length && expected.every((d) => pred.domains.includes(d));
}

function prf(rows) {
  const keys = [...Object.keys(DOMAINS), 'school_other'];
  const out = {};
  for (const k of keys) {
    let tp = 0; let fp = 0; let fn = 0;
    for (const { item, pred } of rows) {
      if (item.action === 'handoff') continue;
      const exp = asList(item.expect).includes(k);
      const got = pred.domains.includes(k);
      if (exp && got) tp += 1; else if (got) fp += 1; else if (exp) fn += 1;
    }
    if (!tp && !fp && !fn) continue;
    const precision = tp + fp ? tp / (tp + fp) : 0;
    const recall = tp + fn ? tp / (tp + fn) : 0;
    out[k] = { precision: round(precision), recall: round(recall), f1: round(precision + recall ? (2 * precision * recall) / (precision + recall) : 0), support: tp + fn };
  }
  return out;
}

const round = (n) => Math.round(n * 1000) / 1000;
const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : 0);

function summarize(rows) {
  const routed = rows.filter((r) => r.domainOk).length;
  const acted = rows.filter((r) => r.actionOk).length;
  const both = rows.filter((r) => r.domainOk && r.actionOk).length;
  const confusion = {};
  for (const { item, pred } of rows) {
    if (Array.isArray(item.expect) || item.action !== 'answer') continue;
    const e = item.expect || 'none';
    const g = pred.domains.length === 1 ? pred.domains[0] || 'none' : pred.domains.join('+');
    confusion[e] = confusion[e] || {};
    confusion[e][g] = (confusion[e][g] || 0) + 1;
  }
  return {
    questions: rows.length,
    routingAccuracy: pct(routed, rows.length),
    actionAccuracy: pct(acted, rows.length),
    fullyCorrect: pct(both, rows.length),
    perTopic: prf(rows),
    confusion,
    mistakes: rows.filter((r) => !r.domainOk || !r.actionOk).map(({ item, pred }) => ({
      id: item.id, role: item.role, q: item.q, expected: item.expect, expectedAction: item.action, got: pred.domains, gotAction: pred.action, confidence: pred.confidence,
    })),
  };
}

async function evaluate({ useModel = false, items = questions.items } = {}) {
  const used = items.filter((i) => useModel || !i.needsModel);
  const rows = [];
  for (const item of used) {
    const pred = await predict(item, { useModel });
    if (useModel) await new Promise((resolve) => setTimeout(resolve, Number(process.env.EVAL_PAUSE_MS || 350))); // stay under the model's rate limit
    rows.push({ item, pred, domainOk: domainCorrect(item, pred), actionOk: pred.action === item.action });
  }
  return {
    mode: useModel ? 'keywords + model' : 'keywords only',
    thresholds: { answer: router.ANSWER_AT, clarify: router.CLARIFY_AT },
    skipped: items.length - used.length,
    overall: summarize(rows),
    dev: summarize(rows.filter((r) => r.item.split === 'dev')),
    holdout: summarize(rows.filter((r) => r.item.split === 'holdout')),
    unseen: summarize(rows.filter((r) => r.item.split === 'unseen')),
    fresh: summarize(rows.filter((r) => r.item.split === 'fresh')),
  };
}

module.exports = { evaluate, predict, questions };
