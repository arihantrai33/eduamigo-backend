// Language model access for EduAmigo Ask, with automatic fallback.
//
//   ASSISTANT_PROVIDERS   order to try, default "azure,gemini" (unconfigured providers are skipped)
//   ASSISTANT_AI=off      turns model calls off; the assistant still works on keywords and templates
//   ASSISTANT_TIMEOUT_MS  per-call timeout, default 10000
//
//   Azure OpenAI: AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_KEY, AZURE_OPENAI_DEPLOYMENT (e.g. gpt-4.1-mini),
//                 AZURE_OPENAI_API_VERSION (default 2024-10-21)
//   Gemini:       GEMINI_API_KEY, ASSISTANT_GEMINI_MODEL (default: the app's GEMINI_CHAT_MODEL, see services/ai.js)
//
// A provider that fails 3 times in a row is skipped for a minute, so a slow or broken provider
// does not make every question wait for its timeout. Identical requests are answered from a
// short-lived cache.

const crypto = require('crypto');
const aiUsage = require('../services/aiUsage');

const FAILURE_LIMIT = 3;
const COOL_OFF_MS = 60 * 1000;
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 500;

const health = new Map(); // provider -> { failures, skipUntil }
const cache = new Map();  // key -> { at, value }

const timeoutMs = () => Number(process.env.ASSISTANT_TIMEOUT_MS || 10000);

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
        const err = new Error(`Azure OpenAI ${res.status}: ${(await res.text()).slice(0, 200)}`);
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
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

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
  for (const name of order()) {
    const h = health.get(name) || { failures: 0, skipUntil: 0 };
    if (h.skipUntil > Date.now()) { errors.push(`${name}: cooling off`); continue; }
    const started = Date.now();
    try {
      // A rate-limit answer (429) means "wait a moment": one short wait and one retry before giving up on the provider.
      let out;
      try {
        out = await PROVIDERS[name].call({ system, user, json, maxTokens, temperature });
      } catch (err) {
        if (!err.retryAfterMs) throw err;
        await new Promise((resolve) => setTimeout(resolve, err.retryAfterMs));
        out = await PROVIDERS[name].call({ system, user, json, maxTokens, temperature });
      }
      if (!out.text) throw new Error('empty response');
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
      const failures = h.failures + 1;
      health.set(name, { failures, skipUntil: failures >= FAILURE_LIMIT ? Date.now() + COOL_OFF_MS : 0 });
      errors.push(`${name}: ${err.message}`);
      if (process.env.NODE_ENV !== 'test') console.error(`[assistant] ${name} failed: ${err.message}`);
    }
  }
  throw new Error(`All language model providers failed (${errors.join('; ')})`);
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
    const signals = [AbortSignal.timeout(timeoutMs()), signal].filter(Boolean);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': process.env.AZURE_OPENAI_API_KEY },
      // include_usage: the provider sends its own token counts in the last chunk, so the ledger is not guessing.
      body: JSON.stringify({ messages, temperature, max_tokens: maxTokens, stream: true, stream_options: { include_usage: true } }),
      signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0],
    });
    if (!res.ok || !res.body) throw new Error(`Azure OpenAI ${res.status}`);
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
    const model = client.getGenerativeModel({ model: PROVIDERS.gemini.model(), systemInstruction: system }, { timeout: timeoutMs() });
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
  for (const name of order()) {
    const h = health.get(name) || { failures: 0, skipUntil: 0 };
    if (h.skipUntil > Date.now()) { errors.push(`${name}: cooling off`); continue; }
    const started = Date.now();
    const meter = { usage: null };
    try {
      const pieces = await STREAMERS[name]({ messages, maxTokens, temperature, signal, meter });
      // Read the first piece here, so a provider that fails or stays silent is skipped before anything is shown.
      const it = pieces[Symbol.asyncIterator]();
      const first = await withTimeout(it.next(), timeoutMs());
      if (first.done) throw new Error('empty response');
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
      aiUsage.record({ feature, provider: name, model: PROVIDERS[name].model(), ok: false, estimated: true, ms: Date.now() - started });
      if (signal?.aborted) throw err;
      const failures = h.failures + 1;
      health.set(name, { failures, skipUntil: failures >= FAILURE_LIMIT ? Date.now() + COOL_OFF_MS : 0 });
      errors.push(`${name}: ${err.message}`);
      if (process.env.NODE_ENV !== 'test') console.error(`[learning] ${name} stream failed: ${err.message}`);
    }
  }
  throw new Error(`All language model providers failed (${errors.join('; ')})`);
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
