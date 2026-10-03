const Student = require('../models/Student');
const BulkUpload = require('../models/BulkUpload');
const { HttpError, asyncHandler } = require('../utils/http');
const { parseClassKey } = require('../utils/classes');
const { saveClassAttendance } = require('../services/attendanceService');
const { createStudentWithAccounts } = require('../services/studentService');
const { createTeacherWithAccount } = require('../services/teacherService');
const academic = require('../services/academic');
const AcademicSession = require('../models/AcademicSession');

const MAX_ROWS = 1000;

// POST /api/bulk/attendance  { className, section, date, status, studentIds? }
const bulkAttendance = asyncHandler(async (req, res) => {
  const { className, section, date, status, studentIds } = req.body || {};
  const key = parseClassKey(className, section);
  const filter = { school: req.schoolId, class: key.class, section: key.section, isActive: true };
  if (Array.isArray(studentIds) && studentIds.length) filter._id = { $in: studentIds };
  const students = await Student.find(filter).select('_id');
  if (!students.length) throw new HttpError(404, 'No students found for this class and section');
  const result = await saveClassAttendance({
    user: req.user, school: req.schoolId, date, cls: key.class, section: key.section,
    records: students.map((s) => ({ studentId: s._id, status: status || 'Present' })),
  });
  res.json({ success: true, message: `Attendance marked for ${result.count} student(s)`, ...result });
});

// POST /api/bulk/promote  { fromClass, fromSection, toClass, toSection, toSession? }
// toSession (e.g. "2027-28") defaults to the current session. Moving into another session closes last
// year's enrollment as "promoted" and opens a new one, so the student's history is kept.
const bulkPromote = asyncHandler(async (req, res) => {
  const from = parseClassKey(req.body?.fromClass, req.body?.fromSection);
  const to = parseClassKey(req.body?.toClass, req.body?.toSection);
  if (!from.class || !from.section || !to.class || !to.section) throw new HttpError(400, 'Source and target class and section are required');
  if (from.class === to.class && from.section === to.section) throw new HttpError(400, 'Source and target must be different');
  await academic.assertClassSection(req.schoolId, to.class, to.section);
  let toSession;
  if (req.body?.toSession) {
    toSession = String(req.body.toSession);
    const known = await AcademicSession.exists({ school: req.schoolId, name: toSession });
    if (!known) throw new HttpError(400, `Session ${toSession} does not exist. Create it first.`);
  }

  const moving = await Student.find({ school: req.schoolId, class: from.class, section: from.section, isActive: true }).select('rollNumber');
  const clashes = await Student.countDocuments({
    school: req.schoolId, class: to.class, section: to.section, rollNumber: { $in: moving.map((s) => s.rollNumber) },
  });
  if (clashes) throw new HttpError(409, `${clashes} roll number(s) already exist in ${to.class}-${to.section}. Resolve them before promoting.`);

  const result = await Student.updateMany(
    { _id: { $in: moving.map((m) => m._id) }, school: req.schoolId, class: from.class, section: from.section, isActive: true },
    { $set: { class: to.class, section: to.section } },
  );
  const moved = await Student.find({ _id: { $in: moving.map((m) => m._id) }, school: req.schoolId, class: to.class, section: to.section });
  await academic.movePlacement(moved, { toSession });
  res.json({ success: true, message: `${result.modifiedCount} student(s) promoted from ${from.class}-${from.section} to ${to.class}-${to.section}`, count: result.modifiedCount });
});

// POST /api/bulk/fee-reminder  { studentIds? } — returns contacts for students with dues
const bulkFeeReminder = asyncHandler(async (req, res) => {
  const { studentIds } = req.body || {};
  const filter = Array.isArray(studentIds) && studentIds.length
    ? { _id: { $in: studentIds }, school: req.schoolId }
    : { feeStatus: { $in: ['Pending', 'Partial'] }, school: req.schoolId, isActive: true };
  const students = await Student.find(filter).select('name class section parentName parentPhone parentEmail feeStatus');
  res.json({ success: true, message: `Fee reminder prepared for ${students.length} student(s)`, data: students });
});

async function runRows(req, rows, createRow, type) {
  if (!Array.isArray(rows) || !rows.length) throw new HttpError(400, 'No rows found in the file');
  if (rows.length > MAX_ROWS) throw new HttpError(400, `A single upload can contain at most ${MAX_ROWS} rows`);
  const errors = [];
  const credentials = [];
  let success = 0;
  for (const [i, row] of rows.entries()) {
    try {
      const out = await createRow(row);
      credentials.push(out.credentials);
      success += 1;
    } catch (e) {
      errors.push({ row: i + 2, message: e.status ? e.message : (e.code === 11000 ? 'Duplicate record' : e.message) });
    }
  }
  await BulkUpload.create({
    type, totalRows: rows.length, success, failed: errors.length, rowErrors: errors,
    uploadedBy: req.user._id, school: req.schoolId,
  });
  return { total: rows.length, success, failed: errors.length, errors, credentials };
}

// POST /api/bulk/upload/students  { students: [...] } — creates login accounts too
const bulkUploadStudents = asyncHandler(async (req, res) => {
  const data = await runRows(req, req.body?.students, (row) => createStudentWithAccounts(req.schoolId, row), 'students');
  res.json({ success: true, data });
});

// POST /api/bulk/upload/teachers  { teachers: [...] }
const bulkUploadTeachers = asyncHandler(async (req, res) => {
  const data = await runRows(req, req.body?.teachers, (row) => createTeacherWithAccount(req.schoolId, row), 'teachers');
  res.json({ success: true, data });
});

module.exports = { bulkAttendance, bulkPromote, bulkFeeReminder, bulkUploadStudents, bulkUploadTeachers };
