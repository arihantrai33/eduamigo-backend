const crypto = require('crypto');
const Fee = require('../models/Fee');
const Student = require('../models/Student');
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
// If another payment changes the fee at the same moment, the save is retried on fresh data.
async function recordPayment(args, attempt = 0) {
  try {
    return await applyPayment(args);
  } catch (err) {
    if (err.name === 'VersionError' && attempt < 3) return recordPayment(args, attempt + 1);
    throw err;
  }
}

async function applyPayment({ school, feeId, amount, mode, reference, collectedBy, onlineOrder }) {
  const fee = await Fee.findOne({ _id: feeId, school });
  if (!fee) throw new HttpError(404, 'Fee record not found');
  // An online order is applied at most once, even if the gateway reports it twice at the same moment.
  if (onlineOrder) {
    const existing = fee.payments.find((p) => p.onlineOrder && String(p.onlineOrder) === String(onlineOrder));
    if (existing) return { fee, payment: existing, duplicate: true };
  }
  const balance = Math.round((fee.amount - (fee.paidAmount || 0)) * 100) / 100;
  if (balance <= 0) throw new HttpError(409, 'This fee is already fully paid');

  const value = amount === undefined || amount === null || amount === '' ? balance : Math.round(Number(amount) * 100) / 100;
  if (!(value > 0)) throw new HttpError(400, 'Payment amount must be greater than 0');
  if (value > balance) throw new HttpError(400, `Payment exceeds the outstanding balance of ${balance}`);
  const paymentMode = PAYMENT_MODES.includes(mode) ? mode : 'Cash';

  const receiptNo = receiptNumber();
  fee.payments.push({ amount: value, mode: paymentMode, reference, receiptNo, collectedBy, onlineOrder, paidAt: new Date() });
  fee.paidAmount = Math.round(((fee.paidAmount || 0) + value) * 100) / 100;
  fee.status = statusFor(fee.amount, fee.paidAmount);
  fee.paymentMode = paymentMode;
  fee.receiptNo = receiptNo;
  fee.paidDate = new Date();
  await fee.save();
  await syncStudentFeeStatus(fee.studentId, fee.school);
  return { fee, payment: fee.payments[fee.payments.length - 1] };
}

function totals(fees) {
  const round = (n) => Math.round(n * 100) / 100;
  const total = fees.reduce((s, f) => s + (f.amount || 0), 0);
  const totalPaid = fees.reduce((s, f) => s + (f.paidAmount || 0), 0);
  return { total: round(total), totalPaid: round(totalPaid), totalDue: round(total - totalPaid) };
}

// Keeps the summary Student.feeStatus (used in lists and filters) in line with the fee records.
async function syncStudentFeeStatus(studentIds, school) {
  if (!school) throw new Error('syncStudentFeeStatus needs the school');
  const ids = [].concat(studentIds).map(String);
  for (const id of ids) {
    const fees = await Fee.find({ school, studentId: id }).select('amount paidAmount');
    await Student.updateOne({ _id: id, school }, { feeStatus: feeStatusFor(fees) });
  }
}

// 'Not billed' when no fee has been raised yet, otherwise Paid / Partial / Pending by balance.
function feeStatusFor(fees) {
  if (!fees.length) return 'Not billed';
  const { total, totalPaid } = totals(fees);
  if (total - totalPaid <= 0.005) return 'Paid';
  return totalPaid > 0 ? 'Partial' : 'Pending';
}

module.exports = { recordPayment, totals, statusFor, syncStudentFeeStatus, feeStatusFor, PAYMENT_MODES };
