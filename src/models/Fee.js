const mongoose = require('mongoose');

const paymentSchema = new mongoose.Schema({
  amount:      { type: Number, required: true, min: 0.01 },
  mode:        { type: String, enum: ['Cash', 'Online', 'Cheque', 'UPI', 'Card', 'Bank Transfer'], default: 'Cash' },
  reference:   { type: String, trim: true },
  receiptNo:   { type: String, required: true },
  paidAt:      { type: Date, default: Date.now },
  collectedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  onlineOrder: { type: mongoose.Schema.Types.ObjectId, ref: 'PaymentOrder' }, // set for gateway payments
}, { _id: true });

const feeSchema = new mongoose.Schema({
  school:         { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true },
  studentId:      { type: mongoose.Schema.Types.ObjectId, ref: 'Student', required: true },
  feeType:        { type: String, required: true, trim: true },
  amount:         { type: Number, required: true, min: 0 },
  paidAmount:     { type: Number, default: 0, min: 0 },
  status:         { type: String, enum: ['Paid', 'Unpaid', 'Partial'], default: 'Unpaid' },
  dueDate:        { type: Date, required: true },
  paidDate:       { type: Date },
  paymentMode:    { type: String, enum: ['Cash', 'Online', 'Cheque', 'UPI', 'Card', 'Bank Transfer'], default: 'Cash' },
  receiptNo:      { type: String },
  payments:       [paymentSchema],
  month:          { type: String },
  year:           { type: Number },
  academicYear:   { type: String },
  remarks:        { type: String },
  feeStructureId: { type: mongoose.Schema.Types.ObjectId, ref: 'FeeStructure' },
}, { timestamps: true, optimisticConcurrency: true }); // two payments at once cannot both apply

feeSchema.virtual('balance').get(function balance() {
  return Math.max(0, (this.amount || 0) - (this.paidAmount || 0));
});
feeSchema.set('toJSON', { virtuals: true });
feeSchema.set('toObject', { virtuals: true });

feeSchema.index({ school: 1, status: 1 });
feeSchema.index({ studentId: 1, feeType: 1, academicYear: 1 });

module.exports = mongoose.model('Fee', feeSchema);
