const mongoose = require('mongoose');

const markSchema = new mongoose.Schema({
  student:     { type: mongoose.Schema.Types.ObjectId, ref: 'Student', required: true },
  teacher:     { type: mongoose.Schema.Types.ObjectId, ref: 'Teacher' },
  school:      { type: mongoose.Schema.Types.ObjectId, ref: 'School' },
  class:       { type: String, required: true },
  section:     { type: String },
  subject:     { type: String, required: true },
  examName:    { type: String, required: true },
  examType:    { type: String, enum: ['Unit Test', 'Mid Term', 'Final', 'Custom'], default: 'Unit Test' },
  maxMarks:    { type: Number, required: true },
  marksObtained: { type: Number },
  weightage:   { type: Number },
  academicYear: { type: String, required: true },
  status:      { type: String, enum: ['draft', 'published'], default: 'draft' },
  publishedAt: { type: Date },
}, { timestamps: true });

module.exports = mongoose.model('Mark', markSchema);
