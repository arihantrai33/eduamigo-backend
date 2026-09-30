const mongoose = require('mongoose');

const feeStructureSchema = new mongoose.Schema({
  school:       { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true },
  academicYear: { type: String, required: true, trim: true },
  class:        { type: String, required: true, trim: true },
  section:      { type: String, default: 'All', trim: true },
  feeType:      { type: String, required: true, trim: true },
  amount:       { type: Number, required: true, min: 0 },
  dueDate:      { type: Date, required: true },
  description:  { type: String, default: '' },
  createdBy:    { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  applyHistory: [{
    appliedAt:     { type: Date },
    appliedBy:     { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    totalStudents: { type: Number },
    created:       { type: Number },
    skipped:       { type: Number },
  }],
}, { timestamps: true });

feeStructureSchema.index(
  { school: 1, academicYear: 1, class: 1, section: 1, feeType: 1 },
  { unique: true }
);

module.exports = mongoose.model('FeeStructure', feeStructureSchema);
