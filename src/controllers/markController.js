const Mark       = require('../models/Mark');
const Student    = require('../models/Student');
const Teacher    = require('../models/Teacher');
const ExamResult = require('../models/ExamResult');
const Notification = require('../models/Notification');
const Parent     = require('../models/Parent');

exports.getMyClasses = async (req, res) => {
  try {
    const teacher = await Teacher.findOne({ userId: req.user._id });
    if (!teacher) return res.status(404).json({ message: 'Teacher not found' });
    res.json({ classes: teacher.assignedClasses, subjects: teacher.subjects });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.getStudentsByClass = async (req, res) => {
  try {
    const { class: cls, section } = req.query;
    const query = { class: cls, isActive: true };
    if (section) query.section = section;
    const students = await Student.find(query)
      .select('name rollNumber class section _id')
      .sort({ rollNumber: 1 });
    res.json(students);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.getMarks = async (req, res) => {
  try {
    const { class: cls, section, subject, examName, academicYear } = req.query;
    const marks = await Mark.find({ class: cls, section, subject, examName, academicYear })
      .populate('student', 'name rollNumber');
    res.json(marks);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.saveMarks = async (req, res) => {
  try {
    const { marksData, class: cls, section, subject, examName, examType, maxMarks, weightage, academicYear } = req.body;
    const teacher = await Teacher.findOne({ userId: req.user._id });
    if (!teacher) return res.status(404).json({ message: 'Teacher not found' });
    const ops = marksData.map(({ studentId, marksObtained }) => ({
      updateOne: {
        filter: { student: studentId, subject, examName, academicYear },
        update: {
          $set: {
            student: studentId, teacher: teacher._id,
            school: teacher.school, class: cls, section,
            subject, examName, examType, maxMarks,
            marksObtained, weightage, academicYear,
            status: 'draft',
          }
        },
        upsert: true,
      }
    }));
    await Mark.bulkWrite(ops);
    res.json({ message: 'Marks saved successfully' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.publishMarks = async (req, res) => {
  try {
    const { class: cls, section, subject, examName, academicYear } = req.body;

    // 1. Mark model mein status published karo
    await Mark.updateMany(
      { class: cls, section, subject, examName, academicYear },
      { $set: { status: 'published', publishedAt: new Date() } }
    );

    // 2. Published marks fetch karo
    const marks = await Mark.find({ class: cls, section, subject, examName, academicYear })
      .populate('student', 'name class section');

    // 3. Har student ke liye ExamResult create/update karo + Notification bhejo
    for (const mark of marks) {
      if (!mark.student || mark.marksObtained === undefined) continue;

      const pct = mark.maxMarks > 0
        ? parseFloat(((mark.marksObtained / mark.maxMarks) * 100).toFixed(1))
        : 0;

      const grade =
        pct >= 90 ? 'A+' :
        pct >= 80 ? 'A'  :
        pct >= 70 ? 'B'  :
        pct >= 60 ? 'C'  :
        pct >= 50 ? 'D'  : 'F';

      // ExamResult upsert
      await ExamResult.findOneAndUpdate(
        { student: mark.student._id, subject, examName },
        {
          $set: {
            student:       mark.student._id,
            teacher:       mark.teacher,
            examName,
            subject,
            class:         cls,
            section,
            totalMarks:    mark.maxMarks,
            marksObtained: mark.marksObtained,
            grade,
            percentage:    pct,
          }
        },
        { upsert: true, new: true }
      );

      const notifTitle   = `Results Published — ${subject}`;
      const notifMessage = `${examName} results for ${subject} have been published. You scored ${mark.marksObtained}/${mark.maxMarks} (${pct}%) — Grade ${grade}.`;

      // Student notification
      await Notification.create({
        title:      notifTitle,
        message:    notifMessage,
        targetRole: 'student',
        targetId:   mark.student._id,
        type:       'Exam',
        sentBy:     req.user._id,
      });

      // Parent notification
      const parent = await Parent.findOne({ children: mark.student._id });
      if (parent) {
        await Notification.create({
          title:      notifTitle,
          message:    `Your child ${mark.student.name} scored ${mark.marksObtained}/${mark.maxMarks} (${pct}%) in ${subject} — ${examName}. Grade: ${grade}.`,
          targetRole: 'parent',
          targetId:   parent._id,
          type:       'Exam',
          sentBy:     req.user._id,
        });
      }
    }

    res.json({ message: 'Marks published successfully', count: marks.length });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
