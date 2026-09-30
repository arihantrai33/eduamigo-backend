const Attendance = require('../models/Attendance');
const Student = require('../models/Student');
const { HttpError, asyncHandler, assertId } = require('../utils/http');
const { toDayKey } = require('../utils/dates');
const { parseClassKey, teacherCoversClass } = require('../utils/classes');
const { saveClassAttendance, summarize, summarizeCounts } = require('../services/attendanceService');
const { studentForUser, resolveChild, teacherForUser, canAccessStudent } = require('../services/directory');

function monthRange(month, year) {
  if (!month || !year) return null;
  const m = Number(month); const y = Number(year);
  if (!(m >= 1 && m <= 12) || !(y > 2000)) throw new HttpError(400, 'Invalid month or year');
  return { $gte: new Date(Date.UTC(y, m - 1, 1)), $lt: new Date(Date.UTC(y, m, 1)) };
}

// POST /api/attendance/bulk  { date, class, section, records: [{ studentId, status, remarks }] }
const markBulkAttendance = asyncHandler(async (req, res) => {
  const { date, class: cls, section, records } = req.body || {};
  const teacher = req.user.role === 'teacher' ? await teacherForUser(req.user) : null;
  const result = await saveClassAttendance({ user: req.user, school: req.schoolId, teacher, date, cls, section, records });
  res.json({ success: true, message: 'Attendance saved successfully', ...result });
});

// POST /api/attendance/mark  { studentId, date, status } — single student
const markAttendance = asyncHandler(async (req, res) => {
  const { studentId, date, status, remarks } = req.body || {};
  assertId(studentId, 'studentId');
  const student = await Student.findOne({ _id: studentId, school: req.schoolId, isActive: true });
  if (!student) throw new HttpError(404, 'Student not found');
  const teacher = req.user.role === 'teacher' ? await teacherForUser(req.user) : null;
  const result = await saveClassAttendance({
    user: req.user, school: req.schoolId, teacher, date,
    cls: student.class, section: student.section, records: [{ studentId, status, remarks }],
  });
  res.status(201).json({ success: true, message: 'Attendance marked successfully', ...result });
});

async function recordsFor(studentId, query) {
  const filter = { studentId };
  const range = monthRange(query.month, query.year);
  if (range) filter.date = range;
  return Attendance.find(filter).sort({ date: -1 });
}

// GET /api/attendance/student/:studentId/summary and /api/attendance/:studentId
const getStudentAttendance = asyncHandler(async (req, res) => {
  assertId(req.params.studentId, 'studentId');
  const student = await Student.findOne({ _id: req.params.studentId, school: req.schoolId });
  if (!(await canAccessStudent(req.user, student))) throw new HttpError(404, 'Student not found');
  const records = await recordsFor(student._id, req.query);
  const summary = summarize(records);
  res.json({ success: true, summary: { ...summary, percentage: `${summary.percentage}%` }, data: records });
});

// GET /api/attendance/class/:className?section=A&date=YYYY-MM-DD
const getClassAttendance = asyncHandler(async (req, res) => {
  const key = parseClassKey(req.params.className, req.query.section);
  if (req.user.role === 'teacher') {
    const teacher = await teacherForUser(req.user);
    if (!teacherCoversClass(teacher, key.class, key.section)) throw new HttpError(403, 'You are not assigned to this class');
  }
  const filter = { school: req.schoolId, class: key.class };
  if (key.section) filter.section = key.section;
  if (req.query.date) {
    const day = toDayKey(req.query.date);
    if (!day) throw new HttpError(400, 'Invalid date');
    filter.date = day;
  }
  const records = await Attendance.find(filter).populate('studentId', 'name rollNumber').sort({ date: -1 });
  res.json({ success: true, count: records.length, data: records });
});

// GET /api/attendance/today (admin) — school-wide snapshot for the dashboard
const getTodaySummary = asyncHandler(async (req, res) => {
  const day = toDayKey(req.query.date || new Date());
  const [records, totalStudents] = await Promise.all([
    Attendance.find({ school: req.schoolId, date: day }).select('status class section'),
    Student.countDocuments({ school: req.schoolId, isActive: true }),
  ]);
  const summary = summarize(records);
  res.json({ success: true, data: { ...summary, marked: records.length, totalStudents, notMarked: Math.max(0, totalStudents - records.length) } });
});

// GET /api/attendance/report?month=&year=&class= (admin) — class-wise percentages
const getAttendanceReport = asyncHandler(async (req, res) => {
  const filter = { school: req.schoolId };
  const range = monthRange(req.query.month, req.query.year);
  if (range) filter.date = range;
  if (req.query.class) filter.class = parseClassKey(req.query.class).class;
  const rows = await Attendance.aggregate([
    { $match: filter },
    { $group: { _id: { class: '$class', section: '$section', status: '$status' }, n: { $sum: 1 } } },
  ]);
  const byClass = {};
  for (const r of rows) {
    const k = `${r._id.class}-${r._id.section}`;
    byClass[k] = byClass[k] || { class: r._id.class, section: r._id.section, counts: {} };
    byClass[k].counts[r._id.status] = r.n;
  }
  const data = Object.values(byClass).map((c) => ({ class: c.class, section: c.section, ...summarizeCounts(c.counts) }))
    .sort((a, b) => String(a.class).localeCompare(String(b.class), undefined, { numeric: true }) || a.section.localeCompare(b.section));
  res.json({ success: true, data });
});

// GET /api/attendance/my-summary (student)
const getMyAttendanceSummary = asyncHandler(async (req, res) => {
  const student = await studentForUser(req.user);
  if (!student) throw new HttpError(404, 'Student not found');
  const records = await recordsFor(student._id, req.query);
  res.json({ success: true, data: summarize(records) });
});

// GET /api/attendance/child-summary?studentId= (parent)
const getChildAttendanceSummary = asyncHandler(async (req, res) => {
  const { child } = await resolveChild(req.user, req.query.studentId);
  if (!child) throw new HttpError(404, 'No child is linked to this account');
  const records = await recordsFor(child._id, req.query);
  res.json({ success: true, data: summarize(records), student: { _id: child._id, name: child.name } });
});

// GET /api/attendance/child-records?studentId= (parent)
const getChildAttendanceRecords = asyncHandler(async (req, res) => {
  const { child } = await resolveChild(req.user, req.query.studentId);
  if (!child) throw new HttpError(404, 'No child is linked to this account');
  res.json({ success: true, data: await recordsFor(child._id, req.query) });
});

module.exports = {
  markAttendance, markBulkAttendance, getStudentAttendance, getClassAttendance,
  getTodaySummary, getAttendanceReport,
  getMyAttendanceSummary, getChildAttendanceSummary, getChildAttendanceRecords,
};
