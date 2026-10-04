// Language model access for EduAmigo Ask, with automatic fallback.
//
//   ASSISTANT_PROVIDERS   order to try, default "azure,gemini" (unconfigured providers are skipped)
//   ASSISTANT_AI=off      turns model calls off; the assistant still works on keywords and templates
//   ASSISTANT_TIMEOUT_MS  per-call timeout, default 6000
//
//   Azure OpenAI: AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_KEY, AZURE_OPENAI_DEPLOYMENT (e.g. gpt-4.1-mini),
//                 AZURE_OPENAI_API_VERSION (default 2024-10-21)
//   Gemini:       GEMINI_API_KEY, ASSISTANT_GEMINI_MODEL (default: the app's GEMINI_CHAT_MODEL, see services/ai.js)
//
// A provider that fails 3 times in a row is skipped for a minute, so a slow or broken provider
// does not make every question wait for its timeout. Identical requests are answered from a
// short-lived cache.

const crypto = require('crypto');

const FAILURE_LIMIT = 3;
const COOL_OFF_MS = 60 * 1000;
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 500;

const health = new Map(); // provider -> { failures, skipUntil }
const cache = new Map();  // key -> { at, value }

const timeoutMs = () => Number(process.env.ASSISTANT_TIMEOUT_MS || 6000);

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
async function complete({ system, user, json = false, maxTokens = 400, temperature = 0.2 }) {
  if (!available()) throw new Error('No language model is configured');
  const key = crypto.createHash('sha256').update(JSON.stringify([system, user, json, maxTokens])).digest('hex');
  const cached = cacheGet(key);
  if (cached) return { ...cached, cached: true, ms: 0 };

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
      cacheSet(key, value);
      return { ...value, cached: false, ms: Date.now() - started };
    } catch (err) {
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

// Which providers would be used, for the admin dashboard and the health check.
const status = () => ({
  enabled: available(),
  providers: order().map((name) => ({ name, model: PROVIDERS[name].model(), coolingOff: (health.get(name)?.skipUntil || 0) > Date.now() })),
});

const resetForTests = () => { health.clear(); cache.clear(); };

module.exports = { complete, completeJson, available, status, resetForTests };
