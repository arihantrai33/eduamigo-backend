// Marks are always entered against a scheduled exam (ExamSchedule). The exam supplies the subject,
// name, type, term, maximum marks and academic year, so teachers never retype them.
const Mark = require('../models/Mark');
const Student = require('../models/Student');
const ExamResult = require('../models/ExamResult');
const ExamSchedule = require('../models/ExamSchedule');
const { HttpError, asyncHandler, assertId } = require('../utils/http');
const { parseClassKey, teacherCoversClass, normalizeSection } = require('../utils/classes');
const { percentage, gradeFor } = require('../utils/grades');
const { toDayKey } = require('../utils/dates');
const { normalizeExamType, termForDate } = require('../config/exams');
const { teacherForUser } = require('../services/directory');
const { notifyStudent, notifyParents } = require('../services/notify');

const sameText = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

// A teacher may enter marks for an exam of a class-section they are assigned to, in a subject they teach.
// Teachers with no subjects on their profile (common for primary class teachers) may enter any subject.
function teacherTeaches(teacher, exam, section) {
  if (!teacherCoversClass(teacher, exam.class, section)) return false;
  const subjects = teacher.subjects || [];
  return !subjects.length || subjects.some((s) => sameText(s, exam.subject));
}

// Loads the exam and the section being marked, and checks who is asking.
async function examContext(req, examId, sectionInput) {
  assertId(examId, 'examId');
  const exam = await ExamSchedule.findOne({ _id: examId, school: req.schoolId });
  if (!exam) throw new HttpError(404, 'Exam not found');
  const section = exam.section || normalizeSection(sectionInput);
  if (!section) throw new HttpError(400, 'Select a section for this exam');
  if (exam.section && sectionInput && normalizeSection(sectionInput) !== exam.section) {
    throw new HttpError(400, `This exam is for section ${exam.section} only`);
  }
  let teacher = null;
  if (req.user.role === 'teacher') {
    teacher = await teacherForUser(req.user);
    if (!teacher) throw new HttpError(404, 'Teacher profile not found');
    if (!teacherTeaches(teacher, exam, section)) throw new HttpError(403, 'You do not teach this subject in this class');
  }
  const key = { exam: exam._id, class: exam.class, section };
  return { exam, section, teacher, key };
}

function examFields(exam) {
  return {
    subject: exam.subject,
    examName: exam.title,
    examType: normalizeExamType(exam.examType),
    term: exam.term || termForDate(exam.date),
    maxMarks: exam.totalMarks,
    academicYear: exam.academicYear,
  };
}

// GET /api/marks/classes (teacher)
exports.getMyClasses = asyncHandler(async (req, res) => {
  const teacher = await teacherForUser(req.user);
  if (!teacher) throw new HttpError(404, 'Teacher profile not found');
  res.json({ classes: teacher.assignedClasses, subjects: teacher.subjects });
});

// GET /api/marks/exams?class=7&section=A (teacher, admin)
// Exams of that class-section the user can mark, with progress for each.
exports.getExamsForMarking = asyncHandler(async (req, res) => {
  const key = parseClassKey(req.query.class, req.query.section);
  if (!key.class || !key.section) throw new HttpError(400, 'Class and section are required');
  let teacher = null;
  if (req.user.role === 'teacher') {
    teacher = await teacherForUser(req.user);
    if (!teacher) throw new HttpError(404, 'Teacher profile not found');
    if (!teacherCoversClass(teacher, key.class, key.section)) throw new HttpError(403, 'You are not assigned to this class');
  }
  const exams = (await ExamSchedule.find({ school: req.schoolId, class: key.class, section: { $in: ['', key.section] } }).sort({ date: -1 }))
    .filter((e) => !teacher || teacherTeaches(teacher, e, key.section));
  const studentCount = await Student.countDocuments({ school: req.schoolId, class: key.class, section: key.section, isActive: true });
  const today = toDayKey(new Date()).getTime();
  const rows = await Mark.aggregate([
    { $match: { school: req.schoolId, exam: { $in: exams.map((e) => e._id) }, section: key.section } },
    { $group: { _id: { exam: '$exam', status: '$status' }, n: { $sum: 1 } } },
  ]);
  const byExam = new Map();
  for (const r of rows) {
    const p = byExam.get(String(r._id.exam)) || { entered: 0, published: 0 };
    p.entered += r.n;
    if (r._id.status === 'published') p.published += r.n;
    byExam.set(String(r._id.exam), p);
  }
  res.json({
    success: true,
    students: studentCount,
    data: exams.map((e) => {
      const p = byExam.get(String(e._id)) || { entered: 0, published: 0 };
      let status = 'Not started';
      if (p.published > 0) status = 'Published';
      else if (p.entered > 0) status = 'Draft';
      return {
        _id: e._id, title: e.title, subject: e.subject, examType: normalizeExamType(e.examType), term: e.term || termForDate(e.date),
        date: e.date, totalMarks: e.totalMarks, academicYear: e.academicYear,
        held: new Date(e.date).getTime() <= today, canEnter: !!e.totalMarks,
        entered: p.entered, status,
      };
    }),
  });
});

// GET /api/marks?examId=&section= (teacher of that class and subject, admin)
// The class list with any marks already saved for this exam.
exports.getMarks = asyncHandler(async (req, res) => {
  const { exam, section, key } = await examContext(req, req.query.examId, req.query.section);
  const [students, marks] = await Promise.all([
    Student.find({ school: req.schoolId, class: exam.class, section, isActive: true }).select('name rollNumber').sort({ rollNumber: 1, name: 1 }),
    Mark.find({ school: req.schoolId, ...key }),
  ]);
  const byStudent = new Map(marks.map((m) => [String(m.student), m]));
  const published = marks.some((m) => m.status === 'published');
  res.json({
    success: true,
    exam: { _id: exam._id, ...examFields(exam), date: exam.date, class: exam.class, section },
    status: published ? 'Published' : marks.length ? 'Draft' : 'Not started',
    data: students.map((s) => {
      const m = byStudent.get(String(s._id));
      return {
        studentId: s._id, name: s.name, rollNumber: s.rollNumber,
        marksObtained: m && !m.absent ? m.marksObtained : null, absent: !!m?.absent,
      };
    }),
  });
});

// POST /api/marks/save { examId, section, marksData: [{ studentId, marksObtained, absent }] } — saves a draft
exports.saveMarks = asyncHandler(async (req, res) => {
  const body = req.body || {};
  if (!body.examId) throw new HttpError(400, 'Select a scheduled exam to enter marks for');
  const { exam, section, teacher, key } = await examContext(req, body.examId, body.section);
  const fields = examFields(exam);
  if (!(fields.maxMarks > 0)) throw new HttpError(400, 'This exam has no total marks set. Ask the admin to add them in the exam schedule.');
  if (toDayKey(exam.date).getTime() > toDayKey(new Date()).getTime()) throw new HttpError(400, 'Marks can be entered once the exam has taken place');
  if (!Array.isArray(body.marksData) || !body.marksData.length) throw new HttpError(400, 'No marks to save');

  const students = await Student.find({ school: req.schoolId, class: exam.class, section, isActive: true }).select('_id');
  const allowed = new Set(students.map((s) => String(s._id)));

  const entries = [];
  for (const row of body.marksData) {
    if (!allowed.has(String(row.studentId))) throw new HttpError(400, 'A student in the list does not belong to this class');
    if (row.absent) { entries.push({ studentId: row.studentId, value: undefined, absent: true }); continue; }
    if (row.marksObtained === '' || row.marksObtained === null || row.marksObtained === undefined) continue;
    const value = Number(row.marksObtained);
    if (!(value >= 0 && value <= fields.maxMarks)) throw new HttpError(400, `Marks must be between 0 and ${fields.maxMarks}`);
    entries.push({ studentId: row.studentId, value, absent: false });
  }

  if (await Mark.exists({ school: req.schoolId, ...key, status: 'published' })) {
    throw new HttpError(409, 'These marks are already published and can no longer be edited');
  }

  if (entries.length) {
    await Mark.bulkWrite(entries.map(({ studentId, value, absent }) => ({
      updateOne: {
        filter: { student: studentId, subject: fields.subject, examName: fields.examName, academicYear: fields.academicYear },
        update: {
          $set: {
            ...fields, ...key, student: studentId, school: req.schoolId, teacher: teacher?._id,
            absent, status: 'draft', ...(absent ? {} : { marksObtained: value }),
          },
          ...(absent ? { $unset: { marksObtained: 1 } } : {}),
        },
        upsert: true,
      },
    })));
  }
  res.json({ success: true, message: 'Marks saved as draft', saved: entries.length });
});

// PATCH /api/marks/publish { examId, section } — makes results visible and notifies students and parents
exports.publishMarks = asyncHandler(async (req, res) => {
  const { exam, section, key } = await examContext(req, req.body?.examId, req.body?.section);
  const fields = examFields(exam);
  const marks = await Mark.find({ school: req.schoolId, ...key, status: 'draft' }).populate('student', 'name class section userId parentUserId school');
  if (!marks.length) throw new HttpError(400, 'There are no draft marks to publish');

  const publishedAt = new Date();
  let count = 0;
  for (const mark of marks) {
    if (!mark.student) continue;
    if (!mark.absent && (mark.marksObtained === undefined || mark.marksObtained === null)) continue;
    const obtained = mark.absent ? 0 : mark.marksObtained;
    const pct = percentage(obtained, fields.maxMarks);
    const grade = mark.absent ? 'AB' : gradeFor(pct);

    await ExamResult.findOneAndUpdate(
      { student: mark.student._id, subject: fields.subject, examName: fields.examName, academicYear: fields.academicYear },
      {
        $set: {
          school: req.schoolId, exam: exam._id, student: mark.student._id, teacher: mark.teacher,
          examName: fields.examName, examType: fields.examType, term: fields.term, subject: fields.subject,
          class: exam.class, section, academicYear: fields.academicYear, examDate: exam.date,
          totalMarks: fields.maxMarks, marksObtained: obtained, absent: mark.absent, grade, percentage: pct,
        },
      },
      { upsert: true, returnDocument: 'after' },
    );
    mark.status = 'published';
    mark.publishedAt = publishedAt;
    await mark.save();

    const title = `Results published: ${fields.subject}`;
    const score = mark.absent ? 'was marked absent' : `scored ${obtained}/${fields.maxMarks} (${pct}%), grade ${grade}`;
    await notifyStudent(mark.student, {
      title, type: 'Exam', createdBy: req.user._id,
      message: `${fields.examName} results for ${fields.subject} are out. You ${score}.`,
    });
    await notifyParents(mark.student, {
      title, type: 'Exam', createdBy: req.user._id,
      message: `${mark.student.name} ${score} in ${fields.subject}, ${fields.examName}.`,
    });
    count += 1;
  }
  res.json({ success: true, message: 'Marks published successfully', count });
});

// PATCH /api/marks/unpublish { examId, section } (admin) — reopens published marks for correction
exports.unpublishMarks = asyncHandler(async (req, res) => {
  const { exam, section, key } = await examContext(req, req.body?.examId, req.body?.section);
  const updated = await Mark.updateMany({ school: req.schoolId, ...key, status: 'published' }, { status: 'draft', publishedAt: null });
  if (!updated.modifiedCount) throw new HttpError(400, 'Nothing is published for this exam and section');
  await ExamResult.deleteMany({ school: req.schoolId, exam: exam._id, section });
  res.json({ success: true, message: 'Marks reopened for correction', count: updated.modifiedCount });
});
