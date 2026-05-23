const mongoose = require('mongoose');

const studentSchema = new mongoose.Schema({
  name:         { type: String, required: true, trim: true },
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
  feeStatus:    { type: String, enum: ['Paid', 'Pending', 'Partial'], default: 'Pending' },
  photo:        { type: String },
  school:       { type: mongoose.Schema.Types.ObjectId, ref: 'School', default: null },
  bus:          { type: mongoose.Schema.Types.ObjectId, ref: 'Transport', default: null },
  userId:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  parentUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  isActive:     { type: Boolean, default: true },
}, { timestamps: true });

studentSchema.index({ rollNumber: 1, class: 1, section: 1 }, { unique: true });

module.exports = mongoose.model('Student', studentSchema);