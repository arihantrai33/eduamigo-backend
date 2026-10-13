const mongoose = require('mongoose');

// One row per call to an AI provider (or per call avoided by a cache), attributed to a school and a feature.
// What is stored: who (school, user id), which feature, which provider and model, how many tokens, whether the token counts
// came from the provider or are an estimate, the estimated cost when a price is configured, timing and the outcome.
// What is never stored: the question, the answer, the prompt, notes, names or any key.
const aiUsageSchema = new mongoose.Schema({
  school:   { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true },
  user:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  period:   { type: String, required: true },                  // 'YYYY-MM' (UTC), the month the call is counted in
  feature:  { type: String, required: true },                  // ask | tutor | tutor_verify | practice | practice_verify | practice_mark | embeddings | revision_legacy | voice
  provider: { type: String, default: null },                   // azure | gemini | null (cached)
  model:    { type: String, default: null },
  requests: { type: Number, default: 1 },
  inputTokens:  { type: Number, default: 0 },
  outputTokens: { type: Number, default: 0 },
  // true = the provider did not report tokens and the figures are characters/4 (or 0 for a failed call)
  tokensEstimated: { type: Boolean, default: false },
  audioSeconds: { type: Number, default: 0 },                  // provider-billed voice only (none is configured)
  voice: { type: Boolean, default: false },                    // the question was spoken (browser speech; not billed by EduAmigo)
  cached: { type: Boolean, default: false },                   // answered from a cache: no provider call, no cost
  ok:     { type: Boolean, default: true },
  ms:     { type: Number, default: 0 },
  // Internal estimate = tokens x the price configured in AI_PRICING. null when no price is configured for this model.
  // It is not the provider's invoice; see services/aiUsage.js (summary) for how the two are told apart.
  costEstimate: { type: Number, default: null },
  currency: { type: String, default: null },
  at: { type: Date, default: Date.now },
});

aiUsageSchema.index({ school: 1, period: 1, feature: 1 });
aiUsageSchema.index({ school: 1, user: 1, at: -1 });
aiUsageSchema.index({ at: 1 }, { expireAfterSeconds: Number(process.env.AI_USAGE_RETENTION_DAYS || 400) * 24 * 3600 });

module.exports = mongoose.model('AiUsage', aiUsageSchema);
