const mongoose = require('mongoose');

const attendanceSchema = new mongoose.Schema({
  studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Student', required: true },
  class:     { type: String, required: true },
  section:   { type: String, required: true },
  date:      { type: Date, required: true },
  status:    { type: String, enum: ['Present', 'Absent', 'Late', 'Holiday'], required: true },
  markedBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'Teacher' },
  remarks:   { type: String },
}, { timestamps: true });

module.exports = mongoose.model('Attendance', attendanceSchema);