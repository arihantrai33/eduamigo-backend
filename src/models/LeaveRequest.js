const mongoose = require('mongoose');

const leaveSchema = new mongoose.Schema({
  // Kiska leave hai
  requestedBy: { type: mongoose.Schema.Types.ObjectId, required: true }, // student ya teacher
  role:        { type: String, enum: ['student', 'teacher', 'parent'], required: true },
  name:        { type: String }, // quick reference
  class:       { type: String }, // agar student hai
  
  // Leave Details
  leaveType:   { type: String, enum: ['Sick', 'Personal', 'Family', 'Other'], default: 'Personal' },
  fromDate:    { type: Date, required: true },
  toDate:      { type: Date, required: true },
  reason:      { type: String, required: true },
  
  // Admin Action
  status:      { type: String, enum: ['Pending', 'Approved', 'Rejected'], default: 'Pending' },
  reviewedBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  reviewNote:  { type: String },
  reviewedAt:  { type: Date },
}, { timestamps: true });

module.exports = mongoose.model('LeaveRequest', leaveSchema);