const mongoose = require('mongoose');

// The employee record of a non-teaching member of staff (office, accounts, library, transport...). Teachers keep theirs in Teacher.
// Payroll and staff leave are still tied to teachers (Salary, StaffLeave); extending them to this record is a separate, planned step.
const staffProfileSchema = new mongoose.Schema({
  school:      { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true },
  user:        { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  employeeId:  { type: String, trim: true, maxlength: 30, default: '' },
  designation: { type: String, trim: true, maxlength: 80, default: '' },
  department:  { type: String, trim: true, maxlength: 80, default: '' },
  phone:       { type: String, trim: true, maxlength: 20, default: '' },
  joiningDate: { type: Date },
}, { timestamps: true });

staffProfileSchema.index({ school: 1, user: 1 }, { unique: true });
staffProfileSchema.index({ school: 1, employeeId: 1 }, { unique: true, partialFilterExpression: { employeeId: { $gt: '' } } });

module.exports = mongoose.model('StaffProfile', staffProfileSchema);
