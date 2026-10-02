const mongoose = require('mongoose');
const { TERMS } = require('../config/exams');

// Class teacher's remarks printed on a student's report card for one term.
const reportCardRemarkSchema = new mongoose.Schema({
  school:       { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true },
  student:      { type: mongoose.Schema.Types.ObjectId, ref: 'Student', required: true },
  academicYear: { type: String, required: true },
  term:         { type: String, enum: [...TERMS, 'Full Year'], required: true },
  remarks:      { type: String, trim: true, maxlength: 600, default: '' },
  updatedBy:    { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

reportCardRemarkSchema.index({ school: 1, student: 1, academicYear: 1, term: 1 }, { unique: true });

module.exports = mongoose.model('ReportCardRemark', reportCardRemarkSchema);
