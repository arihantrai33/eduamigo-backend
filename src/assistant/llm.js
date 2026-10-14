// Language model access for EduAmigo Ask, with automatic fallback.
//
//   ASSISTANT_PROVIDERS   order to try, default "azure,gemini" (unconfigured providers are skipped)
//   ASSISTANT_AI=off      turns model calls off; the assistant still works on keywords and templates
//   ASSISTANT_TIMEOUT_MS  per-call timeout, default 10000 (for streamed answers: time to the first piece)
//   ASSISTANT_STREAM_TIMEOUT_MS  cap on a whole streamed answer, default 60000
//   ASSISTANT_RETRIES     extra tries of one provider after a transient failure (DNS, connection, timeout, 429, 5xx), default 2
//   ASSISTANT_RETRY_BASE_MS  first wait before a retry, default 300 (then x3, with jitter)
//   ASSISTANT_RETRY_BUDGET_MS  the most time all tries and providers may take before the first answer, default 25000
//   Wrong keys (401/403), wrong endpoint or deployment (404) and refused requests (400/422) are never retried: see llmErrors.js.
//
//   Azure OpenAI: AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_KEY, AZURE_OPENAI_DEPLOYMENT (e.g. gpt-4.1-mini),
//                 AZURE_OPENAI_API_VERSION (default 2024-10-21)
//   Gemini:       GEMINI_API_KEY, ASSISTANT_GEMINI_MODEL (default: the app's GEMINI_CHAT_MODEL, see services/ai.js)
//
// A provider that fails 3 times in a row (not counting network failures, which are not its fault) is skipped for a minute, so a slow or broken provider
// does not make every question wait for its timeout. Identical requests are answered from a
// short-lived cache.

const crypto = require('crypto');
const aiUsage = require('../services/aiUsage');
const { AiError, classify, reasonOf, backoffMs, redact, sleep } = require('./llmErrors');

const FAILURE_LIMIT = 3;
const COOL_OFF_MS = 60 * 1000;
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 500;

const health = new Map(); // provider -> { failures, skipUntil }
const cache = new Map();  // key -> { at, value }

const timeoutMs = () => Number(process.env.ASSISTANT_TIMEOUT_MS || 10000);
// A streamed answer may take longer than one ordinary call: timeoutMs() applies to the connection and the first piece, this to
// the whole answer. (Before, the short limit cut every long answer, Hindi ones especially, and the fallback then failed the same way.)
const streamTimeoutMs = () => Math.max(timeoutMs(), Number(process.env.ASSISTANT_STREAM_TIMEOUT_MS || 60000));
const maxRetries = () => (process.env.ASSISTANT_RETRIES === undefined ? 2 : Math.max(0, Number(process.env.ASSISTANT_RETRIES)));
const retryBudgetMs = () => Number(process.env.ASSISTANT_RETRY_BUDGET_MS || 25000);
const NETWORK_KINDS = new Set(['dns', 'connect', 'reset']); // the machine's or the network's fault, not the provider's

const PROVIDERS = {
  azure: {
    configured: () => !!(process.env.AZURE_OPENAI_ENDPOINT && process.env.AZURE_OPENAI_API_KEY && process.env.AZURE_OPENAI_DEPLOYMENT),
    model: () => process.env.AZURE_OPENAI_DEPLOYMENT,
    async call({ system, user, json, maxTokens, temperature }) {
      const endpoint = process.env.AZURE_OPENAI_ENDPOINT.replace(/\/+$/, '');
      const version = process.env.AZURE_OPENAI_API_VERSION || '2024-10-21';
      const url = `${endpoint}/openai/deployments/${encodeURIComponent(process.env.AZURE_OPENAI_DEPLOYMENT)}/chat/completions?api-version=${version}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'api-key': process.env.AZURE_OPENAI_API_KEY },
        body: JSON.stringify({
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
          temperature, max_tokens: maxTokens,
          ...(json ? { response_format: { type: 'json_object' } } : {}),
        }),
        signal: AbortSignal.timeout(timeoutMs()),
      });
      if (!res.ok) {
        const err = Object.assign(new Error(`Azure OpenAI ${res.status}: ${redact((await res.text()).slice(0, 200))}`), { status: res.status });
        if (res.status === 429) err.retryAfterMs = Math.min(Number(res.headers.get('retry-after') || 1) * 1000, 4000);
        throw err;
      }
      const data = await res.json();
      return {
        text: data.choices?.[0]?.message?.content || '',
        usage: { input: data.usage?.prompt_tokens || 0, output: data.usage?.completion_tokens || 0 },
      };
    },
  },
  gemini: {
    configured: () => !!process.env.GEMINI_API_KEY,
    model: () => process.env.ASSISTANT_GEMINI_MODEL || require('../services/ai').CHAT_MODEL,
    async call({ system, user, json, maxTokens, temperature }) {
      const { GoogleGenerativeAI } = require('@google/generative-ai');
      const client = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
      const model = client.getGenerativeModel({ model: PROVIDERS.gemini.model(), systemInstruction: system }, { timeout: timeoutMs() });
      const result = await withTimeout(model.generateContent({
        contents: [{ role: 'user', parts: [{ text: user }] }],
        // Gemini 3 models spend output tokens on internal reasoning too, so the budget is larger than the answer.
        generationConfig: { temperature, maxOutputTokens: Math.max(maxTokens * 4, 1024), ...(json ? { responseMimeType: 'application/json' } : {}) },
      }), timeoutMs());
      const meta = result.response.usageMetadata || {};
      return { text: result.response.text(), usage: { input: meta.promptTokenCount || 0, output: meta.candidatesTokenCount || 0 } };
    },
  },
};

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error(`timed out after ${ms} ms`), { code: 'ETIMEOUT' })), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Runs fn(), and again after a short growing wait when it failed for a reason that can pass by itself (llmErrors.classify). Stops at
// once for a wrong key, a wrong endpoint or a refused request, when the person cancelled, after maxRetries(), or when the time
// budget (`deadline`) would be exceeded. The last error carries `kind` and `attempts`.
async function withRetries(fn, { deadline, signal } = {}) {
  let attempt = 0;
  for (;;) {
    try {
      return { value: await fn(attempt), attempts: attempt + 1 };
    } catch (err) {
      const c = classify(err);
      err.kind = c.kind; err.errCode = c.code; err.attempts = attempt + 1;
      const wait = c.kind === 'rate_limit' ? Math.min(err.retryAfterMs ?? 1000, 4000) : backoffMs(attempt);
      if (signal?.aborted || !c.retryable || attempt >= maxRetries() || Date.now() + wait >= deadline) throw err;
      await sleep(wait, signal);
      attempt += 1;
    }
  }
}

// One line for the server log: the kind of failure, never the request, a key or the endpoint's address.
const describe = (err) => `${err.kind || classify(err).kind}${err.errCode ? ` (${err.errCode})` : ''} after ${err.attempts || 1} attempt${(err.attempts || 1) === 1 ? '' : 's'}: ${redact(err.message)}`;
const noteFailure = (name, h, err) => {
  const failures = NETWORK_KINDS.has(err.kind) ? 0 : h.failures + 1;
  health.set(name, { failures, skipUntil: failures >= FAILURE_LIMIT ? Date.now() + COOL_OFF_MS : 0 });
};
const failedAll = (errors) => new AiError(`All language model providers failed (${errors.map((e) => e.text).join('; ')})`, {
  reason: reasonOf(errors.map((e) => e.kind)), kinds: errors.map((e) => e.kind), attempts: errors.reduce((n, e) => n + (e.attempts || 1), 0),
});

function order() {
  const names = String(process.env.ASSISTANT_PROVIDERS || 'azure,gemini').split(',').map((s) => s.trim()).filter((n) => PROVIDERS[n]);
  return names.filter((n) => PROVIDERS[n].configured());
}

// True when at least one provider can be called right now.
function available() {
  if (String(process.env.ASSISTANT_AI || '').toLowerCase() === 'off') return false;
  return order().length > 0;
}

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) { cache.delete(key); return null; }
  return hit.value;
}

function cacheSet(key, value) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, { at: Date.now(), value });
}

// One completion. Returns { text, provider, model, usage, ms, cached } or throws when every provider failed.
// cache: false for calls that must not repeat an earlier answer (new practice questions, marking a fresh attempt).
// feature: what the call is for in the usage ledger (defaults to the feature set around the request, see services/aiUsage.js).
async function complete({ system, user, json = false, maxTokens = 400, temperature = 0.2, cache: useCache = true, feature }) {
  if (!available()) throw new Error('No language model is configured');
  const key = crypto.createHash('sha256').update(JSON.stringify([system, user, json, maxTokens])).digest('hex');
  const cached = useCache ? cacheGet(key) : null;
  if (cached) {
    aiUsage.record({ feature, cached: true });
    return { ...cached, cached: true, ms: 0 };
  }

  const errors = [];
  const deadline = Date.now() + retryBudgetMs();
  for (const name of order()) {
    const h = health.get(name) || { failures: 0, skipUntil: 0 };
    if (h.skipUntil > Date.now()) { errors.push({ text: `${name}: cooling off`, kind: 'server' }); continue; }
    const started = Date.now();
    try {
      // Transient failures (DNS, connection, timeout, 429, 5xx) are tried again a bounded number of times; see withRetries.
      const { value: out } = await withRetries(async () => {
        const r = await PROVIDERS[name].call({ system, user, json, maxTokens, temperature });
        if (!r.text) throw new Error('empty response');
        return r;
      }, { deadline });
      health.set(name, { failures: 0, skipUntil: 0 });
      const value = { text: out.text, provider: name, model: PROVIDERS[name].model(), usage: out.usage };
      if (useCache) cacheSet(key, value);
      const reported = (out.usage?.input || 0) + (out.usage?.output || 0) > 0;
      aiUsage.record({
        feature, provider: name, model: value.model, ms: Date.now() - started, estimated: !reported,
        inputTokens: reported ? out.usage.input : aiUsage.roughTokens(system) + aiUsage.roughTokens(user), outputTokens: reported ? out.usage.output : aiUsage.roughTokens(out.text),
      });
      return { ...value, cached: false, ms: Date.now() - started };
    } catch (err) {
      // A failed call is still a request. What the provider billed for it (if anything) is unknown, so no tokens are claimed.
      aiUsage.record({ feature, provider: name, model: PROVIDERS[name].model(), ok: false, estimated: true, ms: Date.now() - started });
      err.kind = err.kind || classify(err).kind;
      noteFailure(name, h, err);
      errors.push({ text: `${name}: ${err.kind}`, kind: err.kind, attempts: err.attempts });
      if (process.env.NODE_ENV !== 'test') console.error(`[assistant] ${name} failed: ${describe(err)}`);
    }
  }
  throw failedAll(errors);
}

// complete() for JSON answers. Returns the parsed object, or null if the model did not return valid JSON.
async function completeJson(args) {
  const out = await complete({ ...args, json: true });
  const raw = out.text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '');
  try {
    return { ...out, data: JSON.parse(raw) };
  } catch {
    return { ...out, data: null };
  }
}

// Streaming chat for the tutor (src/learning). messages: [{ role: 'system'|'user'|'assistant', content }].
// Returns { provider, model, pieces } where pieces is an async iterable of text. A provider that fails before its first
// piece is skipped and the next one is tried; after the first piece a failure ends the stream (the caller says so).
// `signal` cancels the request (the person stopped the answer or left).
// Each streamer fills `meter.usage = { input, output }` when the provider reports token counts at the end of the stream.
const STREAMERS = {
  async azure({ messages, maxTokens, temperature, signal, meter }) {
    const endpoint = process.env.AZURE_OPENAI_ENDPOINT.replace(/\/+$/, '');
    const version = process.env.AZURE_OPENAI_API_VERSION || '2024-10-21';
    const url = `${endpoint}/openai/deployments/${encodeURIComponent(process.env.AZURE_OPENAI_DEPLOYMENT)}/chat/completions?api-version=${version}`;
    const signals = [AbortSignal.timeout(streamTimeoutMs()), signal].filter(Boolean);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': process.env.AZURE_OPENAI_API_KEY },
      // include_usage: the provider sends its own token counts in the last chunk, so the ledger is not guessing.
      body: JSON.stringify({ messages, temperature, max_tokens: maxTokens, stream: true, stream_options: { include_usage: true } }),
      signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0],
    });
    if (!res.ok || !res.body) {
      const err = Object.assign(new Error(`Azure OpenAI ${res.status}`), { status: res.status });
      if (res.status === 429) err.retryAfterMs = Math.min(Number(res.headers.get('retry-after') || 1) * 1000, 4000);
      throw err;
    }
    return (async function* pieces() {
      const decoder = new TextDecoder();
      let buffer = '';
      for await (const chunk of res.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let nl;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') return;
          // (usage arrives in a chunk before [DONE], handled below)
          let parsed = null;
          try { parsed = JSON.parse(data); } catch { /* a keep-alive or partial line */ }
          if (!parsed) continue;
          if (parsed.usage) meter.usage = { input: parsed.usage.prompt_tokens || 0, output: parsed.usage.completion_tokens || 0 };
          const text = parsed.choices?.[0]?.delta?.content;
          if (text) yield text;
        }
      }
    }());
  },
  async gemini({ messages, maxTokens, temperature, signal, meter }) {
    const { GoogleGenerativeAI } = require('@google/generative-ai');
    const client = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const model = client.getGenerativeModel({ model: PROVIDERS.gemini.model(), systemInstruction: system }, { timeout: streamTimeoutMs() });
    const contents = messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
    const result = await model.generateContentStream({
      contents, generationConfig: { temperature, maxOutputTokens: Math.max(maxTokens * 4, 1024) },
    }, signal ? { signal } : undefined);
    return (async function* pieces() {
      for await (const chunk of result.stream) {
        const text = chunk.text();
        if (text) yield text;
      }
      try {
        const meta = (await result.response).usageMetadata;
        if (meta) meter.usage = { input: meta.promptTokenCount || 0, output: meta.candidatesTokenCount || 0 };
      } catch { /* usage is optional */ }
    }());
  },
};

// The call is recorded in the usage ledger when the stream ends, is cancelled or fails: with the provider's own token counts
// when it sent them, otherwise estimated from the text.
async function stream({ messages, maxTokens = 900, temperature = 0.3, signal, feature } = {}) {
  if (!available()) throw new Error('No language model is configured');
  const errors = [];
  const deadline = Date.now() + retryBudgetMs();
  for (const name of order()) {
    const h = health.get(name) || { failures: 0, skipUntil: 0 };
    if (h.skipUntil > Date.now()) { errors.push({ text: `${name}: cooling off`, kind: 'server' }); continue; }
    const started = Date.now();
    let meter = { usage: null };
    let attempt = null;
    try {
      // Connecting and the first piece of the answer, tried again after a transient failure. Each try has its own abort
      // controller and a time limit (so a stalled DNS lookup or connection is cut off, not left hanging), and a failed try is
      // aborted. After the first piece a failure is not retried: the caller has already shown part of the answer.
      const { value: got } = await withRetries(async () => {
        meter = { usage: null };
        attempt = new AbortController();
        const attemptSignal = signal ? AbortSignal.any([signal, attempt.signal]) : attempt.signal;
        const left = Math.max(50, Math.min(timeoutMs(), deadline - Date.now()));
        try {
          return await withTimeout((async () => {
            const pieces = await STREAMERS[name]({ messages, maxTokens, temperature, signal: attemptSignal, meter });
            const it = pieces[Symbol.asyncIterator]();
            const first = await it.next();
            if (first.done) throw new Error('empty response');
            return { it, first };
          })(), left);
        } catch (err) { attempt.abort(); throw err; }
      }, { deadline, signal });
      const { it, first } = got;
      health.set(name, { failures: 0, skipUntil: 0 });
      const model = PROVIDERS[name].model();
      return {
        provider: name,
        model,
        pieces: (async function* rest() {
          let text = first.value;
          let ok = true;
          try {
            yield first.value;
            for (let n = await it.next(); !n.done; n = await it.next()) { text += n.value; yield n.value; }
          } catch (err) {
            ok = !!signal?.aborted; // a cancelled answer is a normal end; a provider error is a failed call
            throw err;
          } finally {
            const reported = !!meter.usage && (meter.usage.input + meter.usage.output) > 0;
            aiUsage.record({
              feature, provider: name, model, ok, ms: Date.now() - started, estimated: !reported,
              inputTokens: reported ? meter.usage.input : aiUsage.roughTokens(messages.map((m) => m.content).join('\n')),
              outputTokens: reported ? meter.usage.output : aiUsage.roughTokens(text),
            });
          }
        }()),
      };
    } catch (err) {
      attempt?.abort();
      aiUsage.record({ feature, provider: name, model: PROVIDERS[name].model(), ok: false, estimated: true, ms: Date.now() - started });
      if (signal?.aborted) throw err;
      err.kind = err.kind || classify(err).kind;
      noteFailure(name, h, err);
      errors.push({ text: `${name}: ${err.kind}`, kind: err.kind, attempts: err.attempts });
      if (process.env.NODE_ENV !== 'test') console.error(`[learning] ${name} stream failed: ${describe(err)}`);
    }
  }
  throw failedAll(errors);
}

// Why no model is available right now: 'off' (switched off with ASSISTANT_AI=off, as the local test servers are), 'no_provider'
// (nothing configured) or null (available). The two need different fixes, so the screens say which one it is.
function unavailableReason() {
  if (String(process.env.ASSISTANT_AI || '').toLowerCase() === 'off') return 'off';
  return order().length ? null : 'no_provider';
}

// Which providers would be used, for the admin dashboard and the health check.
const status = () => ({
  enabled: available(),
  reason: unavailableReason(),
  providers: order().map((name) => ({ name, model: PROVIDERS[name].model(), coolingOff: (health.get(name)?.skipUntil || 0) > Date.now() })),
});

const resetForTests = () => { health.clear(); cache.clear(); };

module.exports = { complete, completeJson, stream, available, unavailableReason, status, resetForTests };
