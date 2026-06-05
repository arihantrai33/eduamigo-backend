const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
  title:      { type: String, required: true },
  message:    { type: String, required: true },
  targetRole: { type: String, enum: ['all', 'student', 'teacher', 'parent', 'admin'], default: 'all' },
  createdBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

module.exports = mongoose.model('Notification', notificationSchema);
