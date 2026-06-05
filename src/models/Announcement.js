const mongoose = require('mongoose');

const announcementSchema = new mongoose.Schema({
  title:      { type: String, required: true },
  message:    { type: String, required: true },
  targetRole: { type: String, enum: ['all', 'student', 'teacher', 'parent', 'admin'], default: 'all' },
  priority:   { type: String, enum: ['normal', 'important', 'urgent'], default: 'normal' },
  isPinned:   { type: Boolean, default: false },
  createdBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  school:     { type: mongoose.Schema.Types.ObjectId, ref: 'School' },
}, { timestamps: true });

module.exports = mongoose.model('Announcement', announcementSchema);
