const mongoose = require('mongoose');

// One issued phone code. Only keyed hashes are stored (never the phone number or the code). Expired rows are removed by MongoDB.
const phoneOtpSchema = new mongoose.Schema({
  phoneHash: { type: String, required: true },
  purpose:   { type: String, default: 'test' },
  codeHash:  { type: String, required: true },
  attempts:  { type: Number, default: 0 },
  maxAttempts: { type: Number, default: 5 },
  sentAt:    { type: Date, default: Date.now },
  expiresAt: { type: Date, required: true },
  usedAt:    { type: Date, default: null },
}, { timestamps: true });

phoneOtpSchema.index({ phoneHash: 1, purpose: 1, sentAt: -1 });
phoneOtpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 3600 });

module.exports = mongoose.model('PhoneOtp', phoneOtpSchema);
