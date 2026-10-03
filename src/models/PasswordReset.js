const mongoose = require('mongoose');

// A one-time password reset code sent by email. Only a hash of the code is stored.
// Expired codes are removed by MongoDB automatically (TTL index).
const passwordResetSchema = new mongoose.Schema({
  user:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  codeHash:  { type: String, required: true },
  attempts:  { type: Number, default: 0 },
  expiresAt: { type: Date, required: true },
}, { timestamps: true });

passwordResetSchema.index({ user: 1 });
passwordResetSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('PasswordReset', passwordResetSchema);
