const mongoose = require('mongoose');

// Monthly usage per school (for plan limits and billing), e.g. { metric: 'ai_questions', period: '2026-10' }.
const usageCounterSchema = new mongoose.Schema({
  school: { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true },
  metric: { type: String, required: true },
  period: { type: String, required: true },
  count:  { type: Number, default: 0 },
}, { timestamps: true });

usageCounterSchema.index({ school: 1, metric: 1, period: 1 }, { unique: true });

module.exports = mongoose.model('UsageCounter', usageCounterSchema);
