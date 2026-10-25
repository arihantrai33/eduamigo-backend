const mongoose = require('mongoose');

// A message from EduAmigo to the school offices (maintenance, new feature, billing reminder). Written in the owner console,
// shown on the school admin dashboard while it is active.
const noticeSchema = new mongoose.Schema({
  title:      { type: String, required: true, trim: true, maxlength: 120 },
  message:    { type: String, required: true, trim: true, maxlength: 1000 },
  level:      { type: String, enum: ['info', 'warning', 'critical'], default: 'info' },
  startsAt:   { type: Date, default: Date.now },
  endsAt:     { type: Date, default: null },
  archivedAt: { type: Date, default: null },
  createdBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });
noticeSchema.index({ archivedAt: 1, startsAt: -1 });

module.exports = mongoose.model('PlatformNotice', noticeSchema);
