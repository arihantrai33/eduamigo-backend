// Prices for the internal cost estimate. No price is built in: provider prices change and differ by contract, so they come
// from the deployment's configuration. Without a price the estimate is null ("not priced"), never a guess.
//
//   AI_PRICING='{"currency":"USD","models":{"azure:gpt-4.1-mini":{"inputPer1M":<price>,"outputPer1M":<price>}}}'
//
// A key is "provider:model" or just the model name. Prices are per one million tokens, in the stated currency. Set them from the
// provider's current price list for your agreement. The estimate is tokens x price: it ignores discounts, taxes, rounding,
// and anything the provider bills separately, so it is not an invoice.

let cached = { raw: undefined, parsed: null, error: null };

function load() {
  const raw = process.env.AI_PRICING || '';
  if (cached.raw === raw) return cached;
  cached = { raw, parsed: null, error: null };
  if (!raw.trim()) return cached;
  try {
    const p = JSON.parse(raw);
    const models = {};
    for (const [key, v] of Object.entries(p.models || {})) {
      const inP = Number(v?.inputPer1M); const outP = Number(v?.outputPer1M);
      if (Number.isFinite(inP) && Number.isFinite(outP) && inP >= 0 && outP >= 0) models[key.toLowerCase()] = { inputPer1M: inP, outputPer1M: outP };
    }
    cached.parsed = { currency: String(p.currency || '').toUpperCase().slice(0, 6) || null, models };
  } catch (err) {
    cached.error = `AI_PRICING is not valid JSON (${err.message})`;
  }
  return cached;
}

// { inputPer1M, outputPer1M, currency } or null.
function priceFor(provider, model) {
  const { parsed } = load();
  if (!parsed?.currency) return null;
  const p = parsed.models[`${provider}:${model}`.toLowerCase()] || parsed.models[String(model || '').toLowerCase()];
  return p ? { ...p, currency: parsed.currency } : null;
}

// Cost of one call, or { cost: null } when the model has no configured price.
function estimate(provider, model, inputTokens, outputTokens) {
  const p = priceFor(provider, model);
  if (!p) return { cost: null, currency: null };
  const cost = (inputTokens / 1e6) * p.inputPer1M + (outputTokens / 1e6) * p.outputPer1M;
  return { cost: Math.round(cost * 1e8) / 1e8, currency: p.currency };
}

const status = () => {
  const { parsed, error } = load();
  return { configured: !!parsed?.currency && Object.keys(parsed.models).length > 0, currency: parsed?.currency || null, models: Object.keys(parsed?.models || {}), error };
};

module.exports = { priceFor, estimate, status };
