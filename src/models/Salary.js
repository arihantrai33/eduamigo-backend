const mongoose = require('mongoose');

const salarySchema = new mongoose.Schema({
  teacher:     { type: mongoose.Schema.Types.ObjectId, ref: 'Teacher', required: true },
  month:       { type: Number, required: true, min: 1, max: 12 },
  year:        { type: Number, required: true },
  basicSalary: { type: Number, required: true, min: 0 },
  allowances:  { type: Number, default: 0, min: 0 },
  deductions:  { type: Number, default: 0, min: 0 },
  netSalary:   { type: Number },
  status:      { type: String, enum: ['Pending', 'Paid'], default: 'Pending' },
  paidOn:      { type: Date },
  remarks:     { type: String },
  school:      { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true },
}, { timestamps: true });

salarySchema.index({ school: 1, teacher: 1, month: 1, year: 1 }, { unique: true });

salarySchema.statics.computeNet = (doc) =>
  (Number(doc.basicSalary) || 0) + (Number(doc.allowances) || 0) - (Number(doc.deductions) || 0);

// Mongoose 9 no longer passes `next` to middleware; a plain sync function is required.
salarySchema.pre('save', function computeNetSalary() {
  this.netSalary = this.constructor.computeNet(this);
});

module.exports = mongoose.model('Salary', salarySchema);
