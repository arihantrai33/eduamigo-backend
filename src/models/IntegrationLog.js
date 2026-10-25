const mongoose = require('mongoose');

// A short, sanitized record of integration activity for the owner console. Never holds passwords, API keys, codes or message
// bodies; the recipient is stored masked. Removed automatically after 90 days.
const integrationLogSchema = new mongoose.Schema({
  kind:    { type: String, enum: ['email', 'sms'], required: true },
  action:  { type: String, required: true }, // config | verify | sender_check | test_send | otp_request | otp_verify | send
  ok:      { type: Boolean, required: true },
  code:    { type: String, default: '' },    // short error code, e.g. EAUTH
  message: { type: String, default: '', maxlength: 300 },
  target:  { type: String, default: '' },    // masked recipient
  actor:   { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  createdAt: { type: Date, default: Date.now, index: { expireAfterSeconds: 90 * 24 * 3600 } },
});
integrationLogSchema.index({ kind: 1, createdAt: -1 });

module.exports = mongoose.model('IntegrationLog', integrationLogSchema);
