const mongoose = require('mongoose');

// One row per rate-limit key (see services/rateLimitStore.js). Not tenant data: keys are built from IP, user or login id.
// MongoDB removes a row once its window has ended.
const rateLimitSchema = new mongoose.Schema({
  _id:     { type: String },
  hits:    { type: Number, required: true },
  resetAt: { type: Date, required: true },
}, { versionKey: false });

rateLimitSchema.index({ resetAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('RateLimit', rateLimitSchema);
