const mongoose = require('mongoose');
const { EXAM_TYPES, TERMS } = require('../config/exams');

const markSchema = new mongoose.Schema({
  exam:        { type: mongoose.Schema.Types.ObjectId, ref: 'ExamSchedule', index: true },
  student:     { type: mongoose.Schema.Types.ObjectId, ref: 'Student', required: true },
  teacher:     { type: mongoose.Schema.Types.ObjectId, ref: 'Teacher' },
  school:      { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true },
  class:       { type: String, required: true },
  section:     { type: String },
  subject:     { type: String, required: true },
  examName:    { type: String, required: true },
  examType:    { type: String, enum: EXAM_TYPES, default: 'Unit Test' },
  term:        { type: String, enum: TERMS },
  maxMarks:    { type: Number, required: true },
  marksObtained: { type: Number, min: 0 },
  absent:      { type: Boolean, default: false },
  weightage:   { type: Number },
  academicYear: { type: String, required: true },
  status:      { type: String, enum: ['draft', 'published'], default: 'draft' },
  publishedAt: { type: Date },
}, { timestamps: true });

markSchema.index({ student: 1, subject: 1, examName: 1, academicYear: 1 }, { unique: true });
markSchema.index({ school: 1, class: 1, section: 1, subject: 1, examName: 1, academicYear: 1 });

module.exports = mongoose.model('Mark', markSchema);
