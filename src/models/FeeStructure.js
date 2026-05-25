const mongoose = require('mongoose');

const feeStructureSchema = new mongoose.Schema({
  academicYear:  { type: String, required: true },
  class:         { type: String, required: true },
  section:       { type: String, required: true },
  feeType:       { type: String, required: true },
  amount:        { type: Number, required: true },
  dueDate:       { type: Date,   required: true },
  description:   { type: String, default: '' },
  createdBy:     { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

feeStructureSchema.index({ academicYear: 1, class: 1, section: 1, feeType: 1 }, { unique: true });

module.exports = mongoose.model('FeeStructure', feeStructureSchema);