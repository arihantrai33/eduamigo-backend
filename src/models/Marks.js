const Mark    = require('../models/Mark');
const Student = require('../models/Student');
const Teacher = require('../models/Teacher');

// GET /api/marks/classes — teacher ke assigned classes
exports.getMyClasses = async (req, res) => {
  try {
    const teacher = await Teacher.findOne({ userId: req.user._id });
    if (!teacher) return res.status(404).json({ message: 'Teacher not found' });
    res.json({
      classes:  teacher.assignedClasses,
      subjects: teacher.subjects,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// GET /api/marks/students?class=X-A&section=A — us class ke students
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

// GET /api/marks?class=X-A&section=A&subject=Mathematics&examName=Unit Test 1
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

// POST /api/marks/save — marks save (draft)
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

// PATCH /api/marks/publish — marks publish karo
exports.publishMarks = async (req, res) => {
  try {
    const { class: cls, section, subject, examName, academicYear } = req.body;
    await Mark.updateMany(
      { class: cls, section, subject, examName, academicYear },
      { $set: { status: 'published', publishedAt: new Date() } }
    );
    res.json({ message: 'Marks published successfully' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};