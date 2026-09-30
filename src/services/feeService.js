const crypto = require('crypto');
const Fee = require('../models/Fee');
const { HttpError } = require('../utils/http');

const PAYMENT_MODES = ['Cash', 'Online', 'Cheque', 'UPI', 'Card', 'Bank Transfer'];

function receiptNumber(date = new Date()) {
  const ymd = date.toISOString().slice(0, 10).replace(/-/g, '');
  return `RCPT-${ymd}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

function statusFor(amount, paid) {
  if (paid <= 0) return 'Unpaid';
  if (paid + 0.005 >= amount) return 'Paid';
  return 'Partial';
}

// Records a (possibly partial) payment against a fee. Overpayment is rejected.
async function recordPayment({ school, feeId, amount, mode, reference, collectedBy }) {
  const fee = await Fee.findOne({ _id: feeId, school });
  if (!fee) throw new HttpError(404, 'Fee record not found');
  const balance = Math.round((fee.amount - (fee.paidAmount || 0)) * 100) / 100;
  if (balance <= 0) throw new HttpError(409, 'This fee is already fully paid');

  const value = amount === undefined || amount === null || amount === '' ? balance : Math.round(Number(amount) * 100) / 100;
  if (!(value > 0)) throw new HttpError(400, 'Payment amount must be greater than 0');
  if (value > balance) throw new HttpError(400, `Payment exceeds the outstanding balance of ${balance}`);
  const paymentMode = PAYMENT_MODES.includes(mode) ? mode : 'Cash';

  const receiptNo = receiptNumber();
  fee.payments.push({ amount: value, mode: paymentMode, reference, receiptNo, collectedBy, paidAt: new Date() });
  fee.paidAmount = Math.round(((fee.paidAmount || 0) + value) * 100) / 100;
  fee.status = statusFor(fee.amount, fee.paidAmount);
  fee.paymentMode = paymentMode;
  fee.receiptNo = receiptNo;
  fee.paidDate = new Date();
  await fee.save();
  return { fee, payment: fee.payments[fee.payments.length - 1] };
}

function totals(fees) {
  const round = (n) => Math.round(n * 100) / 100;
  const total = fees.reduce((s, f) => s + (f.amount || 0), 0);
  const totalPaid = fees.reduce((s, f) => s + (f.paidAmount || 0), 0);
  return { total: round(total), totalPaid: round(totalPaid), totalDue: round(total - totalPaid) };
}

module.exports = { recordPayment, totals, statusFor, PAYMENT_MODES };
