const mongoose = require('mongoose');

const examScheduleSchema = new mongoose.Schema({
  school:       { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true },
  title:        { type: String, required: true, trim: true },
  examType:     { type: String, enum: ['Unit Test', 'Mid Term', 'Final', 'Practical', 'Custom'], default: 'Unit Test' },
  subject:      { type: String, required: true, trim: true },
  class:        { type: String, required: true, trim: true },
  section:      { type: String, default: '' },
  date:         { type: Date, required: true },
  startTime:    { type: String },
  endTime:      { type: String },
  totalMarks:   { type: Number, min: 0 },
  venue:        { type: String },
  instructions: { type: String, maxlength: 2000 },
  academicYear: { type: String },
  createdBy:    { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

examScheduleSchema.index({ school: 1, date: 1 });

module.exports = mongoose.model('ExamSchedule', examScheduleSchema);
