const mongoose = require('mongoose');

const leaveSchema = new mongoose.Schema({
  school:      { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true },
  requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  role:        { type: String, enum: ['student', 'teacher', 'parent', 'admin'], required: true },
  name:        { type: String },
  // For student leave (applied by the student or their parent)
  studentId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Student', default: null },
  class:       { type: String },
  section:     { type: String },

  leaveType:   { type: String, enum: ['Sick', 'Personal', 'Family', 'Other'], default: 'Personal' },
  fromDate:    { type: Date, required: true },
  toDate:      { type: Date, required: true },
  days:        { type: Number, default: 1 },
  reason:      { type: String, required: true, maxlength: 1000 },

  status:      { type: String, enum: ['Pending', 'Approved', 'Rejected'], default: 'Pending' },
  reviewedBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  reviewNote:  { type: String },
  reviewedAt:  { type: Date },
}, { timestamps: true });

leaveSchema.index({ school: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model('LeaveRequest', leaveSchema);
