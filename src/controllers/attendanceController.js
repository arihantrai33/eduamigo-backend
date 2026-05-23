const Attendance = require('../models/Attendance');
const Student = require('../models/Student');
const Parent = require('../models/Parent');
const Notification = require('../models/Notification');

const markAttendance = async (req, res) => {
  try {
    const { studentId, date, status, class: studentClass, section } = req.body;
    if (!studentId || !date || !status || !studentClass || !section) {
      return res.status(400).json({ success: false, message: 'studentId, date, status, class and section are required' });
    }
    const existing = await Attendance.findOne({ studentId, date });
    if (existing) {
      return res.status(400).json({ success: false, message: 'Attendance already marked for this date' });
    }
    const attendance = await Attendance.create({ studentId, date, status, class: studentClass, section });
    const parent = await Parent.findOne({ children: studentId });
    if (parent) {
      const student = await Student.findById(studentId);
      await Notification.create({
        title: `Attendance Update: ${status}`,
        message: `${student?.name || 'Student'} was marked ${status} on ${date}.`,
        targetRole: 'parent',
        targetId: parent._id,
        type: 'Info'
      });
    }
    res.status(201).json({ success: true, message: 'Attendance marked successfully!', data: attendance });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

const getStudentAttendance = async (req, res) => {
  try {
    const { studentId } = req.params;
    const { month, year } = req.query;
    const filter = { studentId };
    if (month && year) {
      const start = new Date(year, month - 1, 1);
      const end = new Date(year, month, 0);
      filter.date = { $gte: start, $lte: end };
    }
    const records = await Attendance.find(filter).sort({ date: -1 });
    const total = records.length;
    const present = records.filter(r => r.status === 'Present').length;
    const absent = records.filter(r => r.status === 'Absent').length;
    const percentage = total > 0 ? ((present / total) * 100).toFixed(1) : 0;
    res.status(200).json({
      success: true,
      summary: { total, present, absent, percentage: `${percentage}%` },
      data: records
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

const getClassAttendance = async (req, res) => {
  try {
    const { className } = req.params;
    const { date } = req.query;
    const filter = { class: className };
    if (date) filter.date = new Date(date);
    const records = await Attendance.find(filter).populate('studentId', 'name rollNumber');
    res.status(200).json({ success: true, count: records.length, data: records });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

const getMyAttendanceSummary = async (req, res) => {
  try {
    const student = await Student.findOne({ userId: req.user._id });
    if (!student) {
      return res.status(404).json({ success: false, message: 'Student not found' });
    }
    const records = await Attendance.find({ studentId: student._id }).sort({ date: -1 });
    const total = records.length;
    const present = records.filter(r => r.status === 'Present').length;
    const absent = records.filter(r => r.status === 'Absent').length;
    const percentage = total > 0 ? ((present / total) * 100).toFixed(1) : 0;
    res.status(200).json({
      success: true,
      data: { total, present, absent, percentage: parseFloat(percentage) }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

module.exports = { markAttendance, getStudentAttendance, getClassAttendance, getMyAttendanceSummary };