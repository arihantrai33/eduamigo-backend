const mongoose = require('mongoose');

const STATUSES = ['Enquiry', 'Applied', 'Test Scheduled', 'Approved', 'Admitted', 'Rejected', 'Withdrawn'];
const SOURCES = ['Walk-in', 'Phone', 'Website', 'Referral', 'Social Media', 'Other'];

// A prospective student, from first enquiry until they are admitted (or the application closes).
const admissionSchema = new mongoose.Schema({
  school:         { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true },
  applicationNo:  { type: String, required: true },
  academicYear:   { type: String, required: true },
  classApplied:   { type: String, required: true, trim: true },
  studentName:    { type: String, required: true, trim: true, maxlength: 120 },
  gender:         { type: String, enum: ['Male', 'Female', 'Other', ''], default: '' },
  dateOfBirth:    { type: Date },
  previousSchool: { type: String, trim: true, maxlength: 200 },
  parentName:     { type: String, required: true, trim: true, maxlength: 120 },
  parentPhone:    { type: String, required: true, trim: true },
  parentEmail:    { type: String, trim: true, lowercase: true },
  address:        { type: String, trim: true, maxlength: 400 },
  source:         { type: String, enum: SOURCES, default: 'Walk-in' },
  notes:          { type: String, trim: true, maxlength: 1000 },
  status:         { type: String, enum: STATUSES, default: 'Enquiry' },
  testDate:       { type: Date },
  followUpDate:   { type: Date },
  history: [{
    status: { type: String, enum: STATUSES },
    note:   { type: String, maxlength: 500 },
    by:     { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    at:     { type: Date, default: Date.now },
  }],
  student:        { type: mongoose.Schema.Types.ObjectId, ref: 'Student' },
  createdBy:      { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

admissionSchema.index({ school: 1, applicationNo: 1 }, { unique: true });
admissionSchema.index({ school: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model('Admission', admissionSchema);
module.exports.STATUSES = STATUSES;
module.exports.SOURCES = SOURCES;
