const mongoose = require('mongoose');
const { TERMS } = require('../config/exams');

const examResultSchema = new mongoose.Schema({
  school:        { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true },
  exam:          { type: mongoose.Schema.Types.ObjectId, ref: 'ExamSchedule', index: true },
  student:       { type: mongoose.Schema.Types.ObjectId, ref: 'Student', required: true },
  teacher:       { type: mongoose.Schema.Types.ObjectId, ref: 'Teacher' },
  examName:      { type: String, required: true },
  examType:      { type: String },
  term:          { type: String, enum: TERMS },
  subject:       { type: String, required: true },
  class:         { type: String, required: true },
  section:       { type: String },
  academicYear:  { type: String },
  totalMarks:    { type: Number, required: true, min: 1 },
  marksObtained: { type: Number, required: true, min: 0 },
  grade:         { type: String },
  percentage:    { type: Number },
  examDate:      { type: Date },
  remarks:       { type: String },
  absent:        { type: Boolean, default: false },
}, { timestamps: true });

examResultSchema.index({ student: 1, subject: 1, examName: 1, academicYear: 1 }, { unique: true });
examResultSchema.index({ school: 1, class: 1 });

module.exports = mongoose.model('ExamResult', examResultSchema);
