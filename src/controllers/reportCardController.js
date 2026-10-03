const Student = require('../models/Student');
const ReportCardRemark = require('../models/ReportCardRemark');
const { HttpError, asyncHandler, assertId } = require('../utils/http');
const { parseClassKey, teacherCoversClass } = require('../utils/classes');
const { currentSessionName } = require('../services/academic');
const { canAccessStudent, teacherForUser, studentForUser } = require('../services/directory');
const { buildReportCards, PERIODS } = require('../services/reportCardService');

async function period(query, schoolId) {
  const term = String(query.term || 'Term 1');
  if (!PERIODS.includes(term)) throw new HttpError(400, 'Term must be Term 1, Term 2 or Full Year');
  const academicYear = String(query.academicYear || await currentSessionName(schoolId));
  if (!/^\d{4}-\d{2}$/.test(academicYear)) throw new HttpError(400, 'Academic year must look like 2026-27');
  return { term, academicYear };
}

async function sectionStudents(schoolId, cls, section) {
  return Student.find({ school: schoolId, class: cls, section, isActive: true }).sort({ rollNumber: 1, name: 1 });
}

async function assertTeacherOrAdmin(req, cls, section) {
  if (req.user.role === 'admin') return;
  if (req.user.role === 'teacher' && teacherCoversClass(await teacherForUser(req.user), cls, section)) return;
  throw new HttpError(403, 'You are not assigned to this class');
}

// GET /api/report-cards?class=7&section=A&term=Term 1&academicYear=2026-27 (admin, teacher of the class)
exports.getClassReportCards = asyncHandler(async (req, res) => {
  const key = parseClassKey(req.query.class, req.query.section);
  if (!key.class || !key.section) throw new HttpError(400, 'Class and section are required');
  await assertTeacherOrAdmin(req, key.class, key.section);
  const { term, academicYear } = await period(req.query, req.schoolId);
  const students = await sectionStudents(req.schoolId, key.class, key.section);
  res.json({ success: true, data: await buildReportCards({ schoolId: req.schoolId, students, term, academicYear }) });
});

// GET /api/report-cards/student/:studentId?term=&academicYear= (admin, teacher of the class, the student, their parents)
exports.getStudentReportCard = asyncHandler(async (req, res) => {
  let student;
  if (req.params.studentId === 'me') {
    // A student's own card without needing to know their record id.
    student = req.user.role === 'student' ? await studentForUser(req.user) : null;
  } else {
    assertId(req.params.studentId, 'studentId');
    student = await Student.findOne({ _id: req.params.studentId, school: req.schoolId });
  }
  if (!(await canAccessStudent(req.user, student))) throw new HttpError(404, 'Student not found');
  const { term, academicYear } = await period(req.query, req.schoolId);
  // Built for the whole section so the rank is correct; only this student's card is returned.
  const students = await sectionStudents(req.schoolId, student.class, student.section);
  const report = await buildReportCards({ schoolId: req.schoolId, students, term, academicYear });
  const card = report.cards.find((c) => String(c.student._id) === String(student._id));
  res.json({ success: true, data: { ...report, cards: card ? [card] : [] } });
});

// PUT /api/report-cards/student/:studentId/remarks { term, academicYear, remarks } (admin, teacher of the class)
exports.saveRemarks = asyncHandler(async (req, res) => {
  assertId(req.params.studentId, 'studentId');
  const student = await Student.findOne({ _id: req.params.studentId, school: req.schoolId });
  if (!student) throw new HttpError(404, 'Student not found');
  await assertTeacherOrAdmin(req, student.class, student.section);
  const { term, academicYear } = await period(req.body || {}, req.schoolId);
  const remarks = String(req.body?.remarks || '').trim();
  if (remarks.length > 600) throw new HttpError(400, 'Remarks can be at most 600 characters');
  const doc = await ReportCardRemark.findOneAndUpdate(
    { school: req.schoolId, student: student._id, academicYear, term },
    { remarks, updatedBy: req.user._id },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
  );
  res.json({ success: true, data: { remarks: doc.remarks } });
});
