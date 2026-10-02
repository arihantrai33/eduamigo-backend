const mongoose = require('mongoose');

// One online payment attempt for one fee. A paid order is applied to the fee exactly once.
const paymentOrderSchema = new mongoose.Schema({
  school:            { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true },
  fee:               { type: mongoose.Schema.Types.ObjectId, ref: 'Fee', required: true },
  student:           { type: mongoose.Schema.Types.ObjectId, ref: 'Student', required: true },
  payer:             { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  amount:            { type: Number, required: true, min: 1 }, // rupees
  currency:          { type: String, default: 'INR' },
  provider:          { type: String, default: 'razorpay' },
  providerOrderId:   { type: String, index: true, sparse: true, unique: true },
  providerPaymentId: { type: String },
  // created -> processing -> paid; or failed; or needs_review when money arrived but could not be applied
  status:            { type: String, enum: ['created', 'processing', 'paid', 'failed', 'needs_review'], default: 'created' },
  receiptNo:         { type: String },
  note:              { type: String },
}, { timestamps: true });

paymentOrderSchema.index({ school: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model('PaymentOrder', paymentOrderSchema);
