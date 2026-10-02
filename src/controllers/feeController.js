const Fee = require('../models/Fee');
const Student = require('../models/Student');
const { HttpError, asyncHandler, assertId } = require('../utils/http');
const { toDayKey, currentAcademicYear } = require('../utils/dates');
const { recordPayment, totals, syncStudentFeeStatus } = require('../services/feeService');
const { studentForUser, childrenForParent, canAccessStudent } = require('../services/directory');
const School = require('../models/School');
const { hasPermission } = require('../config/permissions');
const { notifyParents } = require('../services/notify');

const sortFees = { dueDate: -1 };

// POST /api/fees/add (admin) — one-off fee for a single student
const addFee = asyncHandler(async (req, res) => {
  const { studentId, amount, feeType, dueDate, month, year, academicYear, remarks } = req.body || {};
  assertId(studentId, 'studentId');
  if (!(Number(amount) > 0)) throw new HttpError(400, 'Amount must be greater than 0');
  const due = toDayKey(dueDate);
  if (!due) throw new HttpError(400, 'A valid due date is required');
  const student = await Student.findOne({ _id: studentId, school: req.schoolId });
  if (!student) throw new HttpError(404, 'Student not found');

  const fee = await Fee.create({
    school: req.schoolId, studentId, amount: Number(amount), feeType: feeType || 'Tuition',
    dueDate: due, month, year, academicYear: academicYear || currentAcademicYear(due), remarks, status: 'Unpaid',
  });
  await syncStudentFeeStatus(student._id);
  res.status(201).json({ success: true, message: 'Fee record created successfully', data: fee });
});

// GET /api/fees (admin) — all fees in the school, filterable
const getFees = asyncHandler(async (req, res) => {
  const filter = { school: req.schoolId };
  if (req.query.status) filter.status = { $in: String(req.query.status).split(',') };
  if (req.query.academicYear) filter.academicYear = String(req.query.academicYear);
  if (req.query.studentId) { assertId(req.query.studentId, 'studentId'); filter.studentId = req.query.studentId; }
  const fees = await Fee.find(filter).populate('studentId', 'name rollNumber class section').sort(sortFees);
  res.json({ success: true, count: fees.length, summary: totals(fees), data: fees });
});

// GET /api/fees/pending/all (admin)
const getAllPendingFees = asyncHandler(async (req, res) => {
  const fees = await Fee.find({ school: req.schoolId, status: { $ne: 'Paid' } })
    .populate('studentId', 'name rollNumber class section').sort({ dueDate: 1 });
  res.json({ success: true, count: fees.length, summary: totals(fees), data: fees });
});

// GET /api/fees/:studentId (admin)
const getStudentFees = asyncHandler(async (req, res) => {
  assertId(req.params.studentId, 'studentId');
  const fees = await Fee.find({ school: req.schoolId, studentId: req.params.studentId }).sort(sortFees);
  res.json({ success: true, summary: totals(fees), data: fees });
});

// GET /api/fees/my (student: own fees; parent: all linked children)
const getMyFees = asyncHandler(async (req, res) => {
  let studentIds = [];
  if (req.user.role === 'parent') {
    const children = await childrenForParent(req.user);
    if (!children.length) throw new HttpError(404, 'No children are linked to this account');
    studentIds = req.query.studentId
      ? children.filter((c) => String(c._id) === String(req.query.studentId)).map((c) => c._id)
      : children.map((c) => c._id);
    if (!studentIds.length) throw new HttpError(404, 'Child not found');
  } else {
    const student = await studentForUser(req.user);
    if (!student) throw new HttpError(404, 'Student not found');
    studentIds = [student._id];
  }
  const fees = await Fee.find({ school: req.schoolId, studentId: { $in: studentIds } })
    .populate('studentId', 'name class section').sort(sortFees);
  res.json({ success: true, summary: totals(fees), data: fees });
});

// PATCH /api/fees/:feeId/pay (admin)  { amount?, mode?, reference? } — omit amount to pay the full balance
const markFeePaid = asyncHandler(async (req, res) => {
  assertId(req.params.feeId, 'feeId');
  const body = req.body || {};
  const { fee, payment } = await recordPayment({
    school: req.schoolId, feeId: req.params.feeId,
    amount: body.amount ?? body.paidAmount, mode: body.mode || body.paymentMode || body.paymentMethod,
    reference: body.reference, collectedBy: req.user._id,
  });
  const student = await Student.findOne({ _id: fee.studentId, school: req.schoolId });
  if (student) {
    await notifyParents(student, {
      title: 'Fee payment received',
      message: `Payment of Rs ${payment.amount} received for ${student.name} (${fee.feeType}). Receipt: ${payment.receiptNo}.${fee.status === 'Partial' ? ` Balance due: Rs ${fee.balance}.` : ''}`,
      type: 'Fee', createdBy: req.user._id,
    });
  }
  res.json({ success: true, message: fee.status === 'Paid' ? 'Fee fully paid' : 'Partial payment recorded', data: fee, payment });
});

// GET /api/fees/:feeId/receipts/:receiptNo — one payment receipt (fee staff, the student, their parents)
const getReceipt = asyncHandler(async (req, res) => {
  assertId(req.params.feeId, 'feeId');
  const fee = await Fee.findOne({ _id: req.params.feeId, school: req.schoolId });
  if (!fee) throw new HttpError(404, 'Receipt not found');
  const student = await Student.findOne({ _id: fee.studentId, school: req.schoolId });
  const staff = hasPermission(req.user.role, 'fees.read');
  if (!staff && !(await canAccessStudent(req.user, student))) throw new HttpError(404, 'Receipt not found');
  const payment = fee.payments.find((p) => p.receiptNo === req.params.receiptNo);
  if (!payment) throw new HttpError(404, 'Receipt not found');
  const school = await School.findById(req.schoolId).select('name address phone email');
  // Balance right after this payment, so reprinting an old receipt shows what it showed then.
  const paidUpTo = fee.payments.filter((p) => p.paidAt <= payment.paidAt).reduce((sum, p) => sum + p.amount, 0);
  res.json({
    success: true,
    data: {
      school,
      student: student ? { name: student.name, class: student.class, section: student.section, rollNumber: student.rollNumber } : null,
      fee: { _id: fee._id, feeType: fee.feeType, academicYear: fee.academicYear, month: fee.month, year: fee.year, amount: fee.amount, dueDate: fee.dueDate },
      payment: { receiptNo: payment.receiptNo, amount: payment.amount, mode: payment.mode, reference: payment.reference, paidAt: payment.paidAt },
      paidToDate: Math.round(paidUpTo * 100) / 100,
      balanceAfter: Math.max(0, Math.round((fee.amount - paidUpTo) * 100) / 100),
    },
  });
});

module.exports = { getReceipt, addFee, getFees, getStudentFees, getMyFees, markFeePaid, getAllPendingFees };
