const mongoose = require('mongoose');

// One row per reminder already sent, so a repeated or parallel run of the job (restart, two instances) sends it only once.
// The unique key is the fee, which reminder it was, and the due date it was sent for; changing the due date allows a new reminder.
const reminderLogSchema = new mongoose.Schema({
  school:  { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true },
  fee:     { type: mongoose.Schema.Types.ObjectId, ref: 'Fee', required: true },
  days:    { type: Number, required: true },
  dueDate: { type: Date, required: true },
  sentAt:  { type: Date, default: Date.now },
}, { versionKey: false });

reminderLogSchema.index({ fee: 1, days: 1, dueDate: 1 }, { unique: true });
reminderLogSchema.index({ sentAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

module.exports = mongoose.model('ReminderLog', reminderLogSchema);
