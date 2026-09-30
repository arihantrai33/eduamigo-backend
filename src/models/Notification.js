const mongoose = require('mongoose');

// A notification is either:
//  - a broadcast (recipient = null) shown to everyone in the school with a matching targetRole, or
//  - a personal message (recipient = a User) shown only to that user.
// Every notification belongs to exactly one school.
const notificationSchema = new mongoose.Schema({
  school:     { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true, index: true },
  title:      { type: String, required: true, trim: true, maxlength: 200 },
  message:    { type: String, required: true, trim: true, maxlength: 2000 },
  type:       { type: String, enum: ['General', 'Info', 'Fee', 'Exam', 'Attendance', 'Leave', 'Transport', 'Event'], default: 'General' },
  targetRole: { type: String, enum: ['all', 'student', 'teacher', 'parent', 'admin'], default: 'all' },
  recipient:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
  readBy:     [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  createdBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true });

notificationSchema.index({ school: 1, recipient: 1, createdAt: -1 });

module.exports = mongoose.model('Notification', notificationSchema);
