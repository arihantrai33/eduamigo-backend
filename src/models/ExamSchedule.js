const mongoose = require('mongoose');
const { EXAM_TYPES, TERMS } = require('../config/exams');

// One paper: a subject exam for a class (and optionally one section) on a date.
// Marks are always entered against a scheduled exam, so names and maximum marks are never retyped.
const examScheduleSchema = new mongoose.Schema({
  school:       { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true },
  title:        { type: String, required: true, trim: true, maxlength: 120 },
  examType:     { type: String, enum: EXAM_TYPES, default: 'Unit Test' },
  term:         { type: String, enum: TERMS },
  subject:      { type: String, required: true, trim: true },
  class:        { type: String, required: true, trim: true },
  section:      { type: String, default: '' }, // '' = every section of the class
  date:         { type: Date, required: true },
  startTime:    { type: String },
  endTime:      { type: String },
  totalMarks:   { type: Number, min: 1 },
  venue:        { type: String },
  instructions: { type: String, maxlength: 2000 },
  academicYear: { type: String },
  createdBy:    { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

examScheduleSchema.index({ school: 1, date: 1 });
examScheduleSchema.index({ school: 1, class: 1, academicYear: 1 });

module.exports = mongoose.model('ExamSchedule', examScheduleSchema);
