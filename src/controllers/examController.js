const ExamResult = require('../models/ExamResult');
const ExamSchedule = require('../models/ExamSchedule');
const Student = require('../models/Student');
const { HttpError, asyncHandler, assertId, pick } = require('../utils/http');
const { parseClassKey, teacherCoversClass } = require('../utils/classes');
const { gradeFor } = require('../utils/grades');
const { toDayKey, currentAcademicYear } = require('../utils/dates');
const { studentForUser, canAccessStudent, teacherForUser, resolveChild } = require('../services/directory');

function withAverage(results) {
  const avg = results.length
    ? Math.round((results.reduce((s, r) => s + Number(r.percentage || 0), 0) / results.length) * 10) / 10
    : 0;
  return { averagePercentage: avg, overallGrade: results.length ? gradeFor(avg) : null };
}

// ---------- Results (published marks) ----------

// GET /api/exams/my-results (student)
const getMyResults = asyncHandler(async (req, res) => {
  const student = await studentForUser(req.user);
  if (!student) throw new HttpError(404, 'Student not found');
  const results = await ExamResult.find({ student: student._id, school: req.schoolId }).sort({ createdAt: -1 });
  res.json({ success: true, ...withAverage(results), data: results });
});

// GET /api/exams/child-results?studentId= (parent)
const getChildResults = asyncHandler(async (req, res) => {
  const { child } = await resolveChild(req.user, req.query.studentId);
  if (!child) throw new HttpError(404, 'No child is linked to this account');
  const results = await ExamResult.find({ student: child._id, school: req.schoolId }).sort({ createdAt: -1 });
  res.json({ success: true, ...withAverage(results), data: results, student: { _id: child._id, name: child.name } });
});

// GET /api/exams/student/:studentId/results (admin, teacher, own parent, the student)
const getStudentResults = asyncHandler(async (req, res) => {
  assertId(req.params.studentId, 'studentId');
  const student = await Student.findOne({ _id: req.params.studentId, school: req.schoolId });
  if (!(await canAccessStudent(req.user, student))) throw new HttpError(404, 'Student not found');
  const results = await ExamResult.find({ student: student._id, school: req.schoolId }).sort({ createdAt: -1 });
  res.json({ success: true, ...withAverage(results), data: results });
});

// GET /api/exams/results?class=&section=&examName= (admin: all results; teacher: own classes)
const getResults = asyncHandler(async (req, res) => {
  const filter = { school: req.schoolId };
  if (req.query.class) {
    const key = parseClassKey(req.query.class, req.query.section);
    filter.class = key.class;
    if (key.section) filter.section = key.section;
    if (req.user.role === 'teacher' && !teacherCoversClass(await teacherForUser(req.user), key.class, key.section)) {
      throw new HttpError(403, 'You are not assigned to this class');
    }
  } else if (req.user.role === 'teacher') {
    throw new HttpError(400, 'class is required');
  }
  if (req.query.examName) filter.examName = String(req.query.examName);
  if (req.query.academicYear) filter.academicYear = String(req.query.academicYear);
  const results = await ExamResult.find(filter).populate('student', 'name rollNumber class section').sort({ class: 1, examName: 1 });
  res.json({ success: true, count: results.length, data: results });
});

// ---------- Exam schedule ----------

const SCHEDULE_FIELDS = ['title', 'examType', 'subject', 'class', 'section', 'date', 'startTime', 'endTime',
  'totalMarks', 'venue', 'instructions', 'academicYear'];

function scheduleInput(body) {
  const data = pick(body, SCHEDULE_FIELDS);
  if (data.class !== undefined) {
    const key = parseClassKey(data.class, data.section);
    data.class = key.class;
    data.section = key.section;
  }
  if (data.date !== undefined) {
    data.date = toDayKey(data.date);
    if (!data.date) throw new HttpError(400, 'Invalid exam date');
  }
  if (data.totalMarks === '') delete data.totalMarks;
  return data;
}

// GET /api/exams (everyone in the school; students/parents see their class only)
const listSchedule = asyncHandler(async (req, res) => {
  const filter = { school: req.schoolId };
  if (req.user.role === 'student') {
    const s = await studentForUser(req.user);
    if (!s) return res.json({ success: true, data: [] });
    Object.assign(filter, { class: s.class, section: { $in: ['', s.section] } });
  } else if (req.user.role === 'parent') {
    const { child } = await resolveChild(req.user, req.query.studentId);
    if (!child) return res.json({ success: true, data: [] });
    Object.assign(filter, { class: child.class, section: { $in: ['', child.section] } });
  } else if (req.query.class) {
    filter.class = parseClassKey(req.query.class).class;
  }
  const exams = await ExamSchedule.find(filter).sort({ date: 1, startTime: 1 });
  res.json({ success: true, data: exams });
});

const createSchedule = asyncHandler(async (req, res) => {
  const data = scheduleInput(req.body || {});
  if (!data.title || !data.subject || !data.class || !data.date) throw new HttpError(400, 'Title, subject, class and date are required');
  const exam = await ExamSchedule.create({ ...data, academicYear: data.academicYear || currentAcademicYear(data.date), school: req.schoolId, createdBy: req.user._id });
  res.status(201).json({ success: true, data: exam });
});

const updateSchedule = asyncHandler(async (req, res) => {
  assertId(req.params.id);
  const exam = await ExamSchedule.findOneAndUpdate({ _id: req.params.id, school: req.schoolId }, scheduleInput(req.body || {}), { returnDocument: 'after', runValidators: true });
  if (!exam) throw new HttpError(404, 'Exam not found');
  res.json({ success: true, data: exam });
});

const deleteSchedule = asyncHandler(async (req, res) => {
  assertId(req.params.id);
  const exam = await ExamSchedule.findOneAndDelete({ _id: req.params.id, school: req.schoolId });
  if (!exam) throw new HttpError(404, 'Exam not found');
  res.json({ success: true, message: 'Exam deleted' });
});

module.exports = {
  getMyResults, getChildResults, getStudentResults, getResults,
  listSchedule, createSchedule, updateSchedule, deleteSchedule,
};
