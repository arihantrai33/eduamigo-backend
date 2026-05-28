const mongoose = require('mongoose');

const teacherSchema = new mongoose.Schema({
  // Basic Info
  name:         { type: String, required: true, trim: true },
  email:        { type: String, required: true, unique: true, trim: true },
  phone:        { type: String, required: true },
  employeeId:   { type: String, required: true, unique: true, trim: true },

  // Professional Info
  subjects:        [{ type: String, trim: true }],
  assignedClasses: [{ type: String, trim: true }],
  qualification:   { type: String },
  experience:      { type: Number, default: 0 },
  joiningDate:     { type: Date },

  // Personal Info
  gender:      { type: String, enum: ['Male', 'Female', 'Other'] },
  dateOfBirth: { type: Date },
  address:     { type: String },
  photo:       { type: String },

  // System
  salary:   { type: Number, default: 0 },
  userId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  school:   { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true },
  isActive: { type: Boolean, default: true },

}, { timestamps: true });

module.exports = mongoose.model('Teacher', teacherSchema);