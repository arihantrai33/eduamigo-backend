const Mark = require('../models/Mark');
const Student = require('../models/Student');
const ExamResult = require('../models/ExamResult');
const { HttpError, asyncHandler } = require('../utils/http');
const { parseClassKey, teacherCoversClass } = require('../utils/classes');
const { percentage, gradeFor } = require('../utils/grades');
const { teacherForUser } = require('../services/directory');
const { notifyStudent, notifyParents } = require('../services/notify');

const EXAM_TYPES = ['Unit Test', 'Mid Term', 'Final', 'Custom'];

async function requireTeacherForClass(req, cls, section) {
  const teacher = await teacherForUser(req.user);
  if (!teacher) throw new HttpError(404, 'Teacher profile not found');
  if (!teacherCoversClass(teacher, cls, section)) throw new HttpError(403, 'You are not assigned to this class');
  return teacher;
}

function examKey(src) {
  const key = parseClassKey(src.class, src.section);
  const out = {
    class: key.class,
    section: key.section,
    subject: String(src.subject || '').trim(),
    examName: String(src.examName || '').trim(),
    academicYear: String(src.academicYear || '').trim(),
  };
  if (!out.class || !out.section || !out.subject || !out.examName || !out.academicYear) {
    throw new HttpError(400, 'Class, section, subject, exam name and academic year are required');
  }
  return out;
}

// GET /api/marks/classes (teacher)
exports.getMyClasses = asyncHandler(async (req, res) => {
  const teacher = await teacherForUser(req.user);
  if (!teacher) throw new HttpError(404, 'Teacher profile not found');
  res.json({ classes: teacher.assignedClasses, subjects: teacher.subjects });
});

// GET /api/marks/students?class=10&section=A (teacher)
exports.getStudentsByClass = asyncHandler(async (req, res) => {
  const key = parseClassKey(req.query.class, req.query.section);
  if (!key.class) throw new HttpError(400, 'class is required');
  await requireTeacherForClass(req, key.class, key.section);
  const query = { school: req.schoolId, class: key.class, isActive: true };
  if (key.section) query.section = key.section;
  const students = await Student.find(query).select('name rollNumber class section _id').sort({ rollNumber: 1 });
  res.json(students);
});

// GET /api/marks?class=&section=&subject=&examName=&academicYear= (teacher, admin)
exports.getMarks = asyncHandler(async (req, res) => {
  const key = examKey(req.query);
  if (req.user.role === 'teacher') await requireTeacherForClass(req, key.class, key.section);
  const marks = await Mark.find({ school: req.schoolId, ...key }).populate('student', 'name rollNumber');
  res.json(marks);
});

// POST /api/marks/save (teacher) — draft marks; published marks cannot be edited
exports.saveMarks = asyncHandler(async (req, res) => {
  const body = req.body || {};
  const key = examKey(body);
  const teacher = await requireTeacherForClass(req, key.class, key.section);
  const maxMarks = Number(body.maxMarks);
  if (!(maxMarks > 0)) throw new HttpError(400, 'Maximum marks must be greater than 0');
  const examType = EXAM_TYPES.includes(body.examType) ? body.examType : 'Custom';
  if (!Array.isArray(body.marksData) || !body.marksData.length) throw new HttpError(400, 'No marks to save');

  const students = await Student.find({ school: req.schoolId, class: key.class, section: key.section, isActive: true }).select('_id');
  const allowed = new Set(students.map((s) => String(s._id)));

  const entries = [];
  for (const { studentId, marksObtained } of body.marksData) {
    if (!allowed.has(String(studentId))) throw new HttpError(400, 'A student in the list does not belong to this class');
    if (marksObtained === '' || marksObtained === null || marksObtained === undefined) continue;
    const value = Number(marksObtained);
    if (!(value >= 0 && value <= maxMarks)) throw new HttpError(400, `Marks must be between 0 and ${maxMarks}`);
    entries.push({ studentId, value });
  }

  const published = await Mark.exists({ school: req.schoolId, ...key, status: 'published' });
  if (published) throw new HttpError(409, 'These marks are already published and can no longer be edited');

  if (entries.length) {
    await Mark.bulkWrite(entries.map(({ studentId, value }) => ({
      updateOne: {
        filter: { student: studentId, subject: key.subject, examName: key.examName, academicYear: key.academicYear },
        update: {
          $set: {
            ...key, student: studentId, teacher: teacher._id, school: req.schoolId,
            examType, maxMarks, marksObtained: value,
            weightage: body.weightage !== undefined && body.weightage !== '' ? Number(body.weightage) : undefined,
            status: 'draft',
          },
        },
        upsert: true,
      },
    })));
  }
  res.json({ message: 'Marks saved successfully', saved: entries.length });
});

// PATCH /api/marks/publish (teacher) — makes results visible and notifies students and parents
exports.publishMarks = asyncHandler(async (req, res) => {
  const key = examKey(req.body || {});
  await requireTeacherForClass(req, key.class, key.section);

  const marks = await Mark.find({ school: req.schoolId, ...key, status: 'draft' }).populate('student', 'name class section userId parentUserId school');
  if (!marks.length) throw new HttpError(400, 'There are no draft marks to publish');

  const publishedAt = new Date();
  let count = 0;
  for (const mark of marks) {
    if (!mark.student || mark.marksObtained === undefined || mark.marksObtained === null) continue;
    const pct = percentage(mark.marksObtained, mark.maxMarks);
    const grade = gradeFor(pct);

    await ExamResult.findOneAndUpdate(
      { student: mark.student._id, subject: key.subject, examName: key.examName, academicYear: key.academicYear },
      {
        $set: {
          school: req.schoolId, student: mark.student._id, teacher: mark.teacher,
          examName: key.examName, subject: key.subject, class: key.class, section: key.section,
          academicYear: key.academicYear, totalMarks: mark.maxMarks, marksObtained: mark.marksObtained,
          grade, percentage: pct,
        },
      },
      { upsert: true, returnDocument: 'after' },
    );
    mark.status = 'published';
    mark.publishedAt = publishedAt;
    await mark.save();

    const title = `Results published: ${key.subject}`;
    await notifyStudent(mark.student, {
      title, type: 'Exam', createdBy: req.user._id,
      message: `${key.examName} results for ${key.subject} are out. You scored ${mark.marksObtained}/${mark.maxMarks} (${pct}%), grade ${grade}.`,
    });
    await notifyParents(mark.student, {
      title, type: 'Exam', createdBy: req.user._id,
      message: `${mark.student.name} scored ${mark.marksObtained}/${mark.maxMarks} (${pct}%) in ${key.subject}, ${key.examName}. Grade: ${grade}.`,
    });
    count += 1;
  }
  res.json({ message: 'Marks published successfully', count });
});
