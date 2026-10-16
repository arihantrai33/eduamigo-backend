const ExamResult = require('../models/ExamResult');
const ExamSchedule = require('../models/ExamSchedule');
const Student = require('../models/Student');
const { HttpError, asyncHandler, assertId, pick } = require('../utils/http');
const { parseClassKey, teacherCoversClass } = require('../utils/classes');
const { gradeFor } = require('../utils/grades');
const { toDayKey } = require('../utils/dates');
const { sessionNameForDate } = require('../services/academic');
const { EXAM_TYPES, TERMS, normalizeExamType, termForDate } = require('../config/exams');
const Mark = require('../models/Mark');
const { studentForUser, canAccessStudent, teacherForUser, resolveChild, parentUserIdsForStudent } = require('../services/directory');
const Notification = require('../models/Notification');
const push = require('../services/push');

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

const SCHEDULE_FIELDS = ['title', 'examType', 'term', 'subject', 'class', 'section', 'date', 'startTime', 'endTime',
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
  if (data.totalMarks === '' || data.totalMarks === null) delete data.totalMarks;
  if (data.totalMarks !== undefined) {
    data.totalMarks = Number(data.totalMarks);
    if (!(data.totalMarks > 0)) throw new HttpError(400, 'Total marks must be greater than 0');
  }
  if (data.examType !== undefined) data.examType = normalizeExamType(data.examType);
  if (data.term !== undefined && data.term !== '' && !TERMS.includes(data.term)) throw new HttpError(400, 'Term must be Term 1 or Term 2');
  if (data.term === '') delete data.term;
  if (typeof data.title === 'string') data.title = data.title.trim();
  if (typeof data.subject === 'string') data.subject = data.subject.trim();
  for (const t of ['startTime', 'endTime']) {
    if (data[t] === undefined || data[t] === null) continue;
    data[t] = String(data[t]).trim();
    if (data[t] && !/^([01]\d|2[0-3]):[0-5]\d$/.test(data[t])) throw new HttpError(400, 'Times must be in HH:MM format');
  }
  return data;
}

// End time, when given, must come after the start time.
function assertTimes({ startTime, endTime }) {
  if (startTime && endTime && endTime <= startTime) throw new HttpError(400, 'End time must be after the start time');
}

const fmtExamDate = (d) => new Date(d).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const examWhen = (e) => `${fmtExamDate(e.date)}${e.startTime ? `, ${e.startTime}${e.endTime ? `–${e.endTime}` : ''}` : ''}${e.venue ? `, ${e.venue}` : ''}`;

// Tells the students of the exam's class (or class-section) and their parents. Past-dated exams are not announced.
async function notifyExamAudience(exam, title, message) {
  if (toDayKey(exam.date) < toDayKey(new Date())) return 0;
  const filter = { school: exam.school, class: exam.class, isActive: { $ne: false } };
  if (exam.section) filter.section = exam.section;
  const students = await Student.find(filter).select('userId parentUserId school');
  const recipients = new Set();
  for (const st of students) {
    if (st.userId) recipients.add(String(st.userId));
    (await parentUserIdsForStudent(st)).forEach((id) => recipients.add(id));
  }
  if (!recipients.size) return 0;
  // Repeated saves within a few minutes must not flood inboxes with the same message.
  const recent = await Notification.find({
    school: exam.school, recipient: { $in: [...recipients] }, title, message,
    createdAt: { $gte: new Date(Date.now() - 10 * 60 * 1000) },
  }).select('recipient');
  recent.forEach((n) => recipients.delete(String(n.recipient)));
  if (!recipients.size) return 0;
  await Notification.insertMany([...recipients].map((recipient) => ({
    school: exam.school, recipient, title, message, type: 'Exam', targetRole: 'all',
  })));
  // The same people on their phones (only those who were just told in the app; a failed push never fails the save).
  push.toUsers(exam.school, [...recipients], { title, body: message, data: { type: 'Exam', examId: exam._id } });
  return recipients.size;
}
const safeNotify = (...args) => notifyExamAudience(...args).catch((err) => console.error('Exam notification failed:', err.message));

// The same subject paper cannot be scheduled twice under one name in a year for the same class-section.
async function assertNotDuplicate(school, data, ignoreId) {
  const clash = await ExamSchedule.findOne({
    school, class: data.class, subject: data.subject, title: data.title, academicYear: data.academicYear,
    section: data.section ? { $in: [data.section, ''] } : { $exists: true },
    ...(ignoreId ? { _id: { $ne: ignoreId } } : {}),
  }).select('_id');
  if (clash) throw new HttpError(409, `${data.subject} already has an exam called "${data.title}" for this class this year`);
}

// GET /api/exams/options — exam types and terms the platform accepts
const getOptions = asyncHandler(async (req, res) => {
  res.json({ success: true, data: { examTypes: EXAM_TYPES, terms: TERMS } });
});

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
  if (!data.totalMarks) throw new HttpError(400, 'Total marks are required so that marks can be entered later');
  data.academicYear = data.academicYear || await sessionNameForDate(req.schoolId, data.date);
  data.term = data.term || termForDate(data.date);
  assertTimes(data);
  await assertNotDuplicate(req.schoolId, data);
  const exam = await ExamSchedule.create({ ...data, school: req.schoolId, createdBy: req.user._id });
  await safeNotify(exam, `Exam scheduled: ${exam.subject}`,
    `${exam.title} (${exam.examType}) for Class ${exam.class}${exam.section ? `-${exam.section}` : ''} on ${examWhen(exam)}. Total marks ${exam.totalMarks}.`);
  res.status(201).json({ success: true, data: exam });
});

const updateSchedule = asyncHandler(async (req, res) => {
  assertId(req.params.id);
  const current = await ExamSchedule.findOne({ _id: req.params.id, school: req.schoolId });
  if (!current) throw new HttpError(404, 'Exam not found');
  const update = scheduleInput(req.body || {});
  // Once marks exist, the fields they depend on are locked so results stay consistent.
  const LOCKED = ['title', 'subject', 'class', 'section', 'totalMarks', 'academicYear'];
  const changesLocked = LOCKED.some((f) => update[f] !== undefined && String(update[f]) !== String(current[f] ?? ''));
  if (changesLocked && await Mark.exists({ school: req.schoolId, exam: current._id })) {
    throw new HttpError(409, 'Marks have already been entered for this exam, so its name, subject, class and total marks can no longer change');
  }
  const merged = { ...current.toObject(), ...update };
  assertTimes(merged);
  await assertNotDuplicate(req.schoolId, merged, current._id);
  const exam = await ExamSchedule.findOneAndUpdate({ _id: req.params.id, school: req.schoolId }, update, { returnDocument: 'after', runValidators: true });
  const moved = ['date', 'startTime', 'endTime', 'venue', 'class', 'section']
    .some((f) => String(exam[f] instanceof Date ? exam[f].getTime() : exam[f] ?? '') !== String(current[f] instanceof Date ? current[f].getTime() : current[f] ?? ''));
  if (moved) {
    await safeNotify(exam, `Exam updated: ${exam.subject}`,
      `${exam.title} for Class ${exam.class}${exam.section ? `-${exam.section}` : ''} is now on ${examWhen(exam)}.`);
  }
  res.json({ success: true, data: exam });
});

const deleteSchedule = asyncHandler(async (req, res) => {
  assertId(req.params.id);
  if (await Mark.exists({ school: req.schoolId, exam: req.params.id })) {
    throw new HttpError(409, 'Marks have already been entered for this exam, so it cannot be deleted');
  }
  const exam = await ExamSchedule.findOneAndDelete({ _id: req.params.id, school: req.schoolId });
  if (!exam) throw new HttpError(404, 'Exam not found');
  await safeNotify(exam, `Exam cancelled: ${exam.subject}`,
    `${exam.title} for Class ${exam.class}${exam.section ? `-${exam.section}` : ''} on ${fmtExamDate(exam.date)} has been cancelled.`);
  res.json({ success: true, message: 'Exam deleted' });
});

module.exports = {
  getMyResults, getChildResults, getStudentResults, getResults,
  listSchedule, createSchedule, updateSchedule, deleteSchedule, getOptions,
};
