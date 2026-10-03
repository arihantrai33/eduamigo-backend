const mongoose = require('mongoose');

const studentSchema = new mongoose.Schema({
  name:         { type: String, required: true, trim: true },
  // School-issued admission (registration) number, unique within the school. Assigned automatically
  // when not given (services/academic.js). Used for sign-in and on certificates.
  admissionNo:  { type: String, trim: true, maxlength: 30 },
  email:        { type: String, required: true, unique: true, lowercase: true, trim: true },
  phone:        { type: String, required: true, trim: true },
  rollNumber:   { type: String, required: true, trim: true },
  class:        { type: String, required: true, trim: true },
  section:      { type: String, required: true, trim: true },
  gender:       { type: String, enum: ['Male', 'Female', 'Other'] },
  dateOfBirth:  { type: Date },
  address:      { type: String, trim: true },
  parentName:   { type: String, trim: true },
  parentPhone:  { type: String, trim: true },
  parentEmail:  { type: String, lowercase: true, trim: true },
  // Derived from Fee records by feeService.syncStudentFeeStatus; never set by hand.
  feeStatus:    { type: String, enum: ['Not billed', 'Paid', 'Pending', 'Partial'], default: 'Not billed' },
  photo:        { type: String },
  school:       { type: mongoose.Schema.Types.ObjectId, ref: 'School', default: null },
  bus:          { type: mongoose.Schema.Types.ObjectId, ref: 'Transport', default: null },
  userId:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  parentUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  isActive:     { type: Boolean, default: true },
}, { timestamps: true });

// Roll numbers are unique per class-section within one school (not across schools).
studentSchema.index({ school: 1, class: 1, section: 1, rollNumber: 1 }, { unique: true });
studentSchema.index({ school: 1, isActive: 1, class: 1, section: 1 });
studentSchema.index({ school: 1, admissionNo: 1 }, { unique: true, partialFilterExpression: { admissionNo: { $type: 'string' } } });

module.exports = mongoose.model('Student', studentSchema);