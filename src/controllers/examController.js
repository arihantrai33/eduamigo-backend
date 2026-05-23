const ExamResult = require('../models/ExamResult');

// POST /api/exams/result — Result add karo
const addResult = async (req, res) => {
  try {
    const { studentId, subject, marks, maxMarks, examType, class: cls } = req.body;
    if (!studentId || !subject || marks === undefined || !maxMarks) {
      return res.status(400).json({
        success: false,
        message: 'studentId, subject, marks, maxMarks zaroori hai'
      });
    }
    const percentage = ((marks / maxMarks) * 100).toFixed(1);
    const grade =
      percentage >= 90 ? 'A+' :
      percentage >= 80 ? 'A'  :
      percentage >= 70 ? 'B'  :
      percentage >= 60 ? 'C'  :
      percentage >= 50 ? 'D'  : 'F';

    const result = await ExamResult.create({
      studentId, subject, marks, maxMarks,
      percentage, grade, examType, class: cls
    });
    res.status(201).json({ success: true, message: 'Result save ho gaya!', data: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// GET /api/exams/my-results — Logged in student ke results
const getMyResults = async (req, res) => {
  try {
    const results = await ExamResult.find({ studentId: req.user.id })
      .sort({ createdAt: -1 });

    const avg = results.length
      ? (results.reduce((s, r) => s + Number(r.percentage), 0) / results.length).toFixed(1)
      : 0;

    const overallGrade =
      avg >= 90 ? 'A+' :
      avg >= 80 ? 'A'  :
      avg >= 70 ? 'B'  :
      avg >= 60 ? 'C'  :
      avg >= 50 ? 'D'  : 'F';

    res.status(200).json({
      success: true,
      averagePercentage: avg,
      overallGrade,
      data: results
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// GET /api/exams/:studentId — Student ke saare results
const getStudentResults = async (req, res) => {
  try {
    const results = await ExamResult.find({ studentId: req.params.studentId })
      .sort({ createdAt: -1 });
    const avg = results.length
      ? (results.reduce((s, r) => s + Number(r.percentage), 0) / results.length).toFixed(1)
      : 0;
    res.status(200).json({ success: true, averagePercentage: `${avg}%`, data: results });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// GET /api/exams/class/:className — Poori class ke results
const getClassResults = async (req, res) => {
  try {
    const results = await ExamResult.find({ class: req.params.className })
      .populate('studentId', 'name rollNo');
    res.status(200).json({ success: true, count: results.length, data: results });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

module.exports = { addResult, getStudentResults, getClassResults, getMyResults };