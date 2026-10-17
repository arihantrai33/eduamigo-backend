const mongoose = require('mongoose');
const { displayPhoto } = require('../services/photos');

const studentSchema = new mongoose.Schema({
  name:         { type: String, required: true, trim: true },
  // School-issued admission (registration) number, unique within the school. Assigned automatically
  // when not given (services/academic.js). Used for sign-in and on certificates.
  admissionNo:  { type: String, trim: true, maxlength: 30 },
  // Optional: young students often have no email. Unique across the platform when present.
  email:        { type: String, set: (v) => (v ? String(v).trim().toLowerCase() : undefined) },
  phone:        { type: String, required: true, trim: true },
  rollNumber:   { type: String, required: true, trim: true },
  class:        { type: String, required: true, trim: true },
  section:      { type: String, required: true, trim: true },
  gender:       { type: String, enum: ['Male', 'Female', 'Other'] },
  dateOfBirth:  { type: Date },
  // The date the school admitted the student (calendar day, stored as midnight UTC like other day fields).
  // null means "not recorded": older and imported records have none, and it is never filled in from createdAt,
  // which is only when the record was made in EduAmigo. Set by the admin, by a bulk upload column, or by
  // Admissions when an application is admitted (services/admissionDate.js).
  admittedOn:   { type: Date, default: null },
  address:      { type: String, trim: true },
  parentName:   { type: String, trim: true },
  parentPhone:  { type: String, trim: true },
  parentEmail:  { type: String, lowercase: true, trim: true },
  // Derived from Fee records by feeService.syncStudentFeeStatus; never set by hand.
  feeStatus:    { type: String, enum: ['Not billed', 'Paid', 'Pending', 'Partial'], default: 'Not billed' },
  // photoKey: the private Cloudinary asset (services/photos.js). photo: an old public address, kept only until the
  // photo is migrated. The API never returns photoKey; it returns `photo` as a short-lived private link.
  photo:        { type: String },
  photoKey:     { type: String },
  school:       { type: mongoose.Schema.Types.ObjectId, ref: 'School', default: null },
  bus:          { type: mongoose.Schema.Types.ObjectId, ref: 'Transport', default: null },
  // The stop (_id inside the bus's stops) where this student gets on and off; parents are alerted when the bus is near it.
  busStopId:    { type: mongoose.Schema.Types.ObjectId, default: null },
  userId:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  parentUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  isActive:     { type: Boolean, default: true },
  // Set when the student leaves the school or passes out (services/yearEnd.js). The transfer certificate
  // number is given the first time the certificate is opened.
  exit: {
    status:     { type: String, enum: ['left', 'graduated', null], default: null },
    date:       { type: Date, default: null },
    reason:     { type: String, trim: true, maxlength: 300, default: '' },
    lastClass:  { type: String, default: '' },
    tcNumber:   { type: String, default: '' },
    tcIssuedAt: { type: Date, default: null },
  },
}, { timestamps: true });

studentSchema.set('toJSON', {
  transform(doc, ret) {
    const shown = displayPhoto(ret);
    if (shown) ret.photo = shown; else delete ret.photo;
    delete ret.photoKey;
    return ret;
  },
});

// Roll numbers are unique per class-section within one school (not across schools).
// Among students who are still in the school: a student who left keeps their old roll number on record,
// and the next admission to that class-section can be given it.
studentSchema.index({ school: 1, class: 1, section: 1, rollNumber: 1 }, { unique: true, partialFilterExpression: { isActive: true }, name: 'roll_unique_active' });
studentSchema.index({ school: 1, isActive: 1, class: 1, section: 1 });
studentSchema.index({ email: 1 }, { unique: true, partialFilterExpression: { email: { $type: 'string' } }, name: 'email_unique_when_set' });
studentSchema.index({ school: 1, admissionNo: 1 }, { unique: true, partialFilterExpression: { admissionNo: { $type: 'string' } } });

module.exports = mongoose.model('Student', studentSchema);