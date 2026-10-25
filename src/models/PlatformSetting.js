const mongoose = require('mongoose');

// Platform-wide settings owned by EduAmigo (not by any school): one document per integration ("email", "sms").
// `config` holds non-secret fields. `secrets` holds AES-256-GCM encrypted values (services/secrets.js) and is never sent to a client.
const platformSettingSchema = new mongoose.Schema({
  key:     { type: String, required: true, unique: true, enum: ['email', 'sms', 'platform'] },
  enabled: { type: Boolean, default: false },
  config:  { type: mongoose.Schema.Types.Mixed, default: {} },
  secrets: { type: mongoose.Schema.Types.Mixed, default: {}, select: false },
  // What has actually been observed, kept apart from what was typed in.
  status: {
    connectionVerifiedAt: Date,   // a connection and login to the provider worked with the saved settings
    connectionError:      { type: String, default: '' },
    lastTestAt:           Date,
    lastTestOk:           Boolean,
    lastTestMessage:      { type: String, default: '' },
    lastAcceptedAt:       Date,   // the provider accepted a message (not proof it reached an inbox or phone)
    inboxConfirmedAt:     Date,   // a person confirmed the message arrived
    lastFailureAt:        Date,
  },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

module.exports = mongoose.model('PlatformSetting', platformSettingSchema);
