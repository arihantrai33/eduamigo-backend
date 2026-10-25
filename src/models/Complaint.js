const mongoose = require('mongoose');

// A concern the school raises with a student's parents (behaviour, studies, attendance, fees, anything else), with the parent's
// replies. The parent sees it under Chat > Complaints; the school sees who raised it and whether the parent has answered.
const complaintSchema = new mongoose.Schema({
  school:    { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true },
  student:   { type: mongoose.Schema.Types.ObjectId, ref: 'Student', required: true },
  category:  { type: String, enum: ['Behaviour', 'Studies', 'Attendance', 'Fees', 'Other'], default: 'Other' },
  subject:   { type: String, required: true, trim: true, maxlength: 200 },
  details:   { type: String, trim: true, maxlength: 4000, default: '' },
  status:    { type: String, enum: ['open', 'acknowledged', 'resolved'], default: 'open' },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  raisedBy:  { type: String, default: '' },
  responses: [new mongoose.Schema({ by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, byName: String, role: String, text: { type: String, maxlength: 2000 }, at: { type: Date, default: Date.now } }, { _id: false })],
  resolvedAt: { type: Date, default: null },
}, { timestamps: true });

complaintSchema.index({ school: 1, student: 1, createdAt: -1 });
complaintSchema.index({ school: 1, createdBy: 1, createdAt: -1 });

module.exports = mongoose.model('Complaint', complaintSchema);
