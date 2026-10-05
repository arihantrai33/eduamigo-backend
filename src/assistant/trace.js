// A trace of one request through UnifiedAI: each step with its duration and a few safe details (never the message text).
// Saved with the query log and, when ASSISTANT_LOG=json, written as one JSON line per request for a log collector.

const crypto = require('crypto');

function createTrace({ conversationId = null, role = null } = {}) {
  const requestId = crypto.randomUUID();
  const steps = [];
  const t0 = Date.now();
  let last = t0;
  return {
    requestId,
    // trace.step('understand', { provider: 'azure', parts: 2 }, ok)
    step(name, details = {}, ok = true) {
      const now = Date.now();
      steps.push({ step: name, ms: now - last, ok, ...details });
      last = now;
    },
    steps,
    finish(extra = {}) {
      const line = { requestId, conversationId, role, totalMs: Date.now() - t0, steps, ...extra };
      if (process.env.ASSISTANT_LOG === 'json') console.log(JSON.stringify({ type: 'assistant.request', ...line }));
      return line;
    },
  };
}

module.exports = { createTrace };
