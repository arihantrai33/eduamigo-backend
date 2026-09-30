const FeeStructure = require('../models/FeeStructure');
const Fee = require('../models/Fee');
const Student = require('../models/Student');
const { HttpError, asyncHandler, assertId, pick } = require('../utils/http');
const { parseClassKey } = require('../utils/classes');
const { toDayKey } = require('../utils/dates');
const { statusFor, syncStudentFeeStatus } = require('../services/feeService');
const { notifyParents } = require('../services/notify');

function structureInput(body) {
  const data = pick(body, ['academicYear', 'class', 'section', 'feeType', 'amount', 'dueDate', 'description']);
  if (data.class !== undefined || data.section !== undefined) {
    const key = parseClassKey(data.class, data.section);
    if (data.class !== undefined) data.class = key.class;
    data.section = key.section || 'All';
  }
  if (data.amount !== undefined) {
    data.amount = Number(data.amount);
    if (!(data.amount >= 0)) throw new HttpError(400, 'Amount must be a positive number');
  }
  if (data.dueDate !== undefined) {
    data.dueDate = toDayKey(data.dueDate);
    if (!data.dueDate) throw new HttpError(400, 'Invalid due date');
  }
  return data;
}

function studentFilter(school, structure) {
  const f = { school, class: structure.class, isActive: true };
  if (structure.section && structure.section !== 'All') f.section = structure.section;
  return f;
}

// POST /api/fee-structures
const createFeeStructure = asyncHandler(async (req, res) => {
  const data = structureInput(req.body || {});
  if (!data.academicYear || !data.class || !data.feeType || data.amount === undefined || !data.dueDate) {
    throw new HttpError(400, 'Academic year, class, fee type, amount and due date are required');
  }
  const existing = await FeeStructure.findOne({
    school: req.schoolId, academicYear: data.academicYear, class: data.class, section: data.section, feeType: data.feeType,
  });
  if (existing) {
    throw new HttpError(409, `A ${data.feeType} fee for Class ${data.class}${data.section !== 'All' ? `-${data.section}` : ''} (${data.academicYear}) already exists. Edit it instead.`, { existingId: existing._id });
  }
  const structure = await FeeStructure.create({ ...data, school: req.schoolId, createdBy: req.user._id });
  res.status(201).json({ success: true, message: 'Fee structure created successfully', data: structure });
});

// GET /api/fee-structures
const getAllFeeStructures = asyncHandler(async (req, res) => {
  const filter = { school: req.schoolId };
  if (req.query.academicYear) filter.academicYear = String(req.query.academicYear);
  if (req.query.class) filter.class = parseClassKey(req.query.class).class;
  if (req.query.section) filter.section = String(req.query.section);
  const structures = await FeeStructure.find(filter).sort({ class: 1, section: 1, feeType: 1 }).populate('createdBy', 'name');
  res.json({ success: true, count: structures.length, data: structures });
});

// PUT /api/fee-structures/:id
const updateFeeStructure = asyncHandler(async (req, res) => {
  assertId(req.params.id);
  const structure = await FeeStructure.findOneAndUpdate(
    { _id: req.params.id, school: req.schoolId },
    structureInput(req.body || {}),
    { returnDocument: 'after', runValidators: true },
  );
  if (!structure) throw new HttpError(404, 'Fee structure not found');
  res.json({ success: true, message: 'Fee structure updated successfully', data: structure });
});

// PUT /api/fee-structures/:id/reapply — update the structure and every unpaid/partial fee created from it
const updateAndReapplyFeeStructure = asyncHandler(async (req, res) => {
  assertId(req.params.id);
  const structure = await FeeStructure.findOneAndUpdate(
    { _id: req.params.id, school: req.schoolId },
    structureInput(req.body || {}),
    { returnDocument: 'after', runValidators: true },
  );
  if (!structure) throw new HttpError(404, 'Fee structure not found');

  // Only fees generated from THIS structure, in THIS school, that are not fully paid.
  const fees = await Fee.find({ school: req.schoolId, feeStructureId: structure._id, status: { $ne: 'Paid' } });
  let updated = 0;
  for (const fee of fees) {
    if (structure.amount < (fee.paidAmount || 0)) continue; // never reduce below what was already paid
    fee.amount = structure.amount;
    fee.dueDate = structure.dueDate;
    fee.status = statusFor(fee.amount, fee.paidAmount || 0);
    await fee.save();
    updated += 1;
    const student = await Student.findById(fee.studentId);
    if (student) {
      await notifyParents(student, {
        title: 'Fee updated',
        message: `The ${structure.feeType} fee for ${student.name} (${structure.academicYear}) is now Rs ${structure.amount}, due ${structure.dueDate.toISOString().slice(0, 10)}.`,
        type: 'Fee', createdBy: req.user._id,
      });
    }
  }
  await syncStudentFeeStatus(fees.map((f) => f.studentId));
  res.json({ success: true, message: `Fee structure updated. ${updated} unpaid fee record(s) updated.`, data: structure, updated });
});

// DELETE /api/fee-structures/:id — blocked once fees have been generated from it
const deleteFeeStructure = asyncHandler(async (req, res) => {
  assertId(req.params.id);
  const structure = await FeeStructure.findOne({ _id: req.params.id, school: req.schoolId });
  if (!structure) throw new HttpError(404, 'Fee structure not found');
  const used = await Fee.countDocuments({ school: req.schoolId, feeStructureId: structure._id });
  if (used) throw new HttpError(409, `This fee structure has been applied to ${used} student(s) and cannot be deleted`);
  await structure.deleteOne();
  res.json({ success: true, message: 'Fee structure deleted successfully' });
});

// POST /api/fee-structures/:id/apply — generate fee records for every student in the class/section
const applyFeeStructureToClass = asyncHandler(async (req, res) => {
  assertId(req.params.id);
  const structure = await FeeStructure.findOne({ _id: req.params.id, school: req.schoolId });
  if (!structure) throw new HttpError(404, 'Fee structure not found');

  const students = await Student.find(studentFilter(req.schoolId, structure));
  if (!students.length) {
    throw new HttpError(404, `No active students found for Class ${structure.class}${structure.section !== 'All' ? `-${structure.section}` : ''}`);
  }

  const already = await Fee.find({
    school: req.schoolId, studentId: { $in: students.map((s) => s._id) },
    $or: [
      { feeStructureId: structure._id },
      { feeType: structure.feeType, academicYear: structure.academicYear },
    ],
  }).select('studentId');
  const skip = new Set(already.map((f) => String(f.studentId)));

  const toCreate = students.filter((s) => !skip.has(String(s._id)));
  const due = new Date(structure.dueDate);
  await Fee.insertMany(toCreate.map((s) => ({
    school: req.schoolId, studentId: s._id, feeType: structure.feeType, amount: structure.amount,
    dueDate: structure.dueDate, academicYear: structure.academicYear, feeStructureId: structure._id,
    month: due.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' }), year: due.getUTCFullYear(), status: 'Unpaid',
  })));

  await syncStudentFeeStatus(toCreate.map((s) => s._id));
  for (const s of toCreate) {
    await notifyParents(s, {
      title: 'New fee added',
      message: `A ${structure.feeType} fee of Rs ${structure.amount} has been added for ${s.name} (${structure.academicYear}). Due date: ${structure.dueDate.toISOString().slice(0, 10)}.`,
      type: 'Fee', createdBy: req.user._id,
    });
  }

  await FeeStructure.updateOne({ _id: structure._id }, {
    $push: { applyHistory: { appliedAt: new Date(), appliedBy: req.user._id, totalStudents: students.length, created: toCreate.length, skipped: skip.size } },
  });

  res.json({
    success: true,
    message: `Fee applied to ${toCreate.length} student(s). ${skip.size} already had this fee and were skipped.`,
    data: {
      created: toCreate.length, skipped: skip.size,
      appliedTo: toCreate.map((s) => ({ name: s.name, class: s.class, section: s.section })),
      skippedFor: students.filter((s) => skip.has(String(s._id))).map((s) => ({ name: s.name, reason: 'Fee record already exists' })),
      appliedAt: new Date().toISOString(),
    },
  });
});

// GET /api/fee-structures/summary?academicYear=
const getFeeSummary = asyncHandler(async (req, res) => {
  const match = { school: req.schoolId };
  if (req.query.academicYear) match.academicYear = String(req.query.academicYear);
  const fees = await Fee.find(match).populate('studentId', 'class section').select('amount paidAmount feeType studentId');

  const round = (n) => Math.round(n * 100) / 100;
  const add = (bucket, f) => {
    bucket.billed = round(bucket.billed + f.amount);
    bucket.paid = round(bucket.paid + (f.paidAmount || 0));
    bucket.due = round(bucket.billed - bucket.paid);
  };
  const totalsAll = { billed: 0, paid: 0, due: 0 };
  const byType = {};
  const byClass = {};
  for (const f of fees) {
    add(totalsAll, f);
    byType[f.feeType] = byType[f.feeType] || { billed: 0, paid: 0, due: 0 };
    add(byType[f.feeType], f);
    if (f.studentId) {
      const k = `Class ${f.studentId.class}`;
      byClass[k] = byClass[k] || { billed: 0, paid: 0, due: 0 };
      add(byClass[k], f);
    }
  }
  res.json({
    success: true,
    data: { totalBilled: totalsAll.billed, totalPaid: totalsAll.paid, totalDue: totalsAll.due, byType, byClass, totalRecords: fees.length },
  });
});

module.exports = {
  createFeeStructure, getAllFeeStructures, updateFeeStructure, updateAndReapplyFeeStructure,
  deleteFeeStructure, applyFeeStructureToClass, getFeeSummary,
};
