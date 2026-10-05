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
  let signals = null;
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
    signals = signals || r.signals;
    if (DOMAINS[topic] && topic !== 'general' && r.confidence < router.ANSWER_AT) {
      action = 'clarify';
      if (r.runnerUp && r.confidence >= router.CLARIFY_AT) domains.push(r.runnerUp);
    }
  }
  return { domains: [...new Set(domains)], action, confidence: minConfidence, signals };
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


// Is the confidence worth anything? Questions grouped by the confidence the assistant reported, with the share it
// actually got right in each group. A trustworthy score rises with accuracy; ECE is the average gap between the two
// (0 = perfectly calibrated). Hand-offs are left out (they are rule-based, not scored).
const BUCKETS = [[0, 0.45], [0.45, 0.75], [0.75, 0.9], [0.9, 1.0001]];
function calibration(rows) {
  const scored = rows.filter((r) => r.item.action !== 'handoff' && typeof r.pred.confidence === 'number');
  const buckets = BUCKETS.map(([lo, hi]) => {
    const inB = scored.filter((r) => r.pred.confidence >= lo && r.pred.confidence < hi);
    const correct = inB.filter((r) => r.domainOk && r.actionOk).length;
    const mean = inB.length ? inB.reduce((s, r) => s + r.pred.confidence, 0) / inB.length : 0;
    return { from: lo, to: Math.min(1, hi), questions: inB.length, accuracy: pct(correct, inB.length), meanConfidence: round(mean) };
  });
  const ece = scored.length ? buckets.reduce((s, b) => s + (b.questions / scored.length) * Math.abs(b.accuracy / 100 - b.meanConfidence), 0) : 0;
  // Does agreement between the model and the words add information?
  const withSignals = scored.filter((r) => r.pred.signals);
  const group = (agree) => { const g = withSignals.filter((r) => !!r.pred.signals.agree === agree); return { questions: g.length, accuracy: pct(g.filter((r) => r.domainOk && r.actionOk).length, g.length) }; };
  const answered = scored.filter((r) => r.pred.action === 'answer');
  return {
    buckets, ece: round(ece),
    agreement: withSignals.length ? { modelAndWordsAgree: group(true), disagree: group(false) } : null,
    // What the answer threshold buys: of everything answered straight away, the share that was right.
    answeredDirectly: { questions: answered.length, accuracy: pct(answered.filter((r) => r.domainOk && r.actionOk).length, answered.length) },
  };
}

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
    calibration: calibration(rows),
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
