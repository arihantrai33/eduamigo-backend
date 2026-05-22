const mongoose = require('mongoose');

const feeSchema = new mongoose.Schema({
  studentId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Student', required: true },
  feeType:     { type: String, enum: ['Tuition', 'Transport', 'Library', 'Exam', 'Other'], default: 'Tuition' },
  amount:      { type: Number, required: true },
  paidAmount:  { type: Number, default: 0 },
  status:      { type: String, enum: ['Paid', 'Unpaid', 'Partial'], default: 'Unpaid' },
  dueDate:     { type: Date, required: true },
  paidDate:    { type: Date },
  paymentMode: { type: String, enum: ['Cash', 'Online', 'Cheque', 'UPI'], default: 'Cash' },
  receiptNo:   { type: String },
  month:       { type: String },
  year:        { type: Number },
  remarks:     { type: String },
}, { timestamps: true });

module.exports = mongoose.model('Fee', feeSchema);
