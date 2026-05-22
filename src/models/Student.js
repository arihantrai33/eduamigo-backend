const mongoose = require('mongoose');

const studentSchema = new mongoose.Schema({
  name:        { type: String, required: true },
  email:       { type: String, required: true, unique: true },
  phone:       { type: String, required: true },
  rollNumber:  { type: String, required: true, unique: true },
  class:       { type: String, required: true },
  section:     { type: String, required: true },
  gender:      { type: String, enum: ['Male', 'Female', 'Other'] },
  dateOfBirth: { type: Date },
  address:     { type: String },
  parentName:  { type: String },
  parentPhone: { type: String },
  feeStatus:   { type: String, enum: ['Paid', 'Pending', 'Partial'], default: 'Pending' },
  photo:       { type: String },
  school:      { type: mongoose.Schema.Types.ObjectId, ref: 'School', default: null },
  bus:         { type: mongoose.Schema.Types.ObjectId, ref: 'Transport', default: null },
  userId:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  isActive:    { type: Boolean, default: true },
}, { timestamps: true });

module.exports = mongoose.model('Student', studentSchema);