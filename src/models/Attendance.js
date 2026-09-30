const mongoose = require('mongoose');

// `date` is always stored as midnight UTC of the school's calendar day (see utils/dates.js),
// so one record per student per day is enforced by a unique index.
const attendanceSchema = new mongoose.Schema({
  school:    { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true },
  studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Student', required: true },
  class:     { type: String, required: true },
  section:   { type: String, required: true },
  date:      { type: Date, required: true },
  status:    { type: String, enum: ['Present', 'Absent', 'Late', 'Leave', 'Holiday'], required: true },
  markedBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  remarks:   { type: String, maxlength: 500 },
}, { timestamps: true });

attendanceSchema.index({ studentId: 1, date: 1 }, { unique: true });
attendanceSchema.index({ school: 1, class: 1, section: 1, date: 1 });

module.exports = mongoose.model('Attendance', attendanceSchema);
