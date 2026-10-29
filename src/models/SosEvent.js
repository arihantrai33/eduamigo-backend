const mongoose = require('mongoose');

// One SOS raised from the parent/student app. Kept so the school can see what was raised, where the bus was (from the server's own
// last reading, never from the phone's claim) and what was actually delivered to whom. `delivery` states only what the server did:
// an in-app notification row was created; push is fire-and-forget and is not confirmed; the driver has no account and is not alerted.
const sosEventSchema = new mongoose.Schema({
  school:    { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  role:      { type: String, default: '' },
  student:   { type: mongoose.Schema.Types.ObjectId, ref: 'Student', default: null },
  bus:       { type: mongoose.Schema.Types.ObjectId, ref: 'Transport', default: null },
  tripId:    { type: String, default: '' },
  busPosition: { lat: Number, lng: Number, at: Date, receivedAt: Date },
  note:      { type: String, default: '' },
  requestId: { type: String, default: '' },
  recipients: [{
    user:  { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    inApp: { type: String, enum: ['created', 'failed'], required: true },
    push:  { type: String, default: 'unconfirmed' },
  }],
  driverNotified: { type: Boolean, default: false },
}, { timestamps: { createdAt: true, updatedAt: false } });

sosEventSchema.index({ school: 1, createdAt: -1 });
sosEventSchema.index({ school: 1, createdBy: 1, requestId: 1 }, { unique: true, partialFilterExpression: { requestId: { $gt: '' } } });

module.exports = mongoose.model('SosEvent', sosEventSchema);
