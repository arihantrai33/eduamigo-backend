const mongoose = require('mongoose');

// EduAmigo's bill to a school for a period. Amounts are in rupees. Built by services/billing.js from the
// school's plan, add-ons and active student count when the invoice is created (a snapshot: later price or
// student changes do not alter it).
const STATUSES = ['draft', 'issued', 'paid', 'void'];

const lineSchema = new mongoose.Schema({
  description: { type: String, required: true },
  kind:        { type: String, enum: ['plan', 'addon', 'discount'], required: true },
  quantity:    { type: Number, default: 1 },
  unitPrice:   { type: Number, default: 0 },   // per student (or flat) per year
  periodShare: { type: Number, default: 1 },   // part of a year this invoice covers
  amount:      { type: Number, required: true },
}, { _id: false });

const invoiceSchema = new mongoose.Schema({
  number:         { type: String, required: true, unique: true },
  school:         { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true },
  periodFrom:     { type: Date, required: true },
  periodTo:       { type: Date, required: true },
  plan:           { type: String, default: '' },
  activeStudents: { type: Number, default: 0 },
  lines:          { type: [lineSchema], default: [] },
  subtotal:       { type: Number, required: true },
  taxRate:        { type: Number, default: 18 },
  tax:            { type: Number, required: true },
  total:          { type: Number, required: true },
  status:         { type: String, enum: STATUSES, default: 'draft' },
  dueDate:        { type: Date, default: null },
  issuedAt:       { type: Date, default: null },
  paidAt:         { type: Date, default: null },
  paymentRef:     { type: String, trim: true, maxlength: 120, default: '' },
  notes:          { type: String, trim: true, maxlength: 1000, default: '' },
  createdBy:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true });

invoiceSchema.index({ school: 1, periodFrom: -1 });
invoiceSchema.index({ status: 1, dueDate: 1 });

module.exports = mongoose.model('Invoice', invoiceSchema);
module.exports.INVOICE_STATUSES = STATUSES;
