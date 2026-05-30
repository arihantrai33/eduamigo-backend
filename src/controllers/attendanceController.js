const Attendance = require('../models/Attendance');
const Student = require('../models/Student');
const Parent = require('../models/Parent');
const Notification = require('../models/Notification');
const Teacher = require('../models/Teacher');

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

// BULK — puri class ka attendance ek saath save karo
const markBulkAttendance = async (req, res) => {
  try {
    const { records, date, class: studentClass, section } = req.body;
    if (!records?.length || !date || !studentClass || !section) {
      return res.status(400).json({ success: false, message: 'records, date, class and section are required' });
    }

    const teacherDoc = req.user.role === 'teacher'
      ? await Teacher.findOne({ userId: req.user._id })
      : null;
    const teacherId = teacherDoc?._id || null;

    const results = [];
    for (const r of records) {
      const existing = await Attendance.findOne({ studentId: r.studentId, date: new Date(date) });
      if (existing) {
        existing.status   = r.status;
        existing.remarks  = r.remarks || '';
        existing.markedBy = teacherId;
        await existing.save();
        results.push(existing);
      } else {
        const att = await Attendance.create({
          studentId: r.studentId,
          date:      new Date(date),
          status:    r.status,
          remarks:   r.remarks || '',
          class:     studentClass,
          section,
          markedBy:  teacherId,
        });
        results.push(att);
      }

      // Parent ko notify karo agar Absent/Late — no duplicates
      if (r.status !== 'Present') {
        const parent = await Parent.findOne({ children: r.studentId });
        if (parent) {
          const student = await Student.findById(r.studentId);
          const alreadyNotified = await Notification.findOne({
            targetId: parent._id,
            title: `Attendance: ${r.status}`,
            message: { $regex: date }
          });
          if (!alreadyNotified) {
            await Notification.create({
              title:      `Attendance: ${r.status}`,
              message:    `${student?.name || 'Your child'} was marked ${r.status} on ${date}.`,
              targetRole: 'parent',
              targetId:   parent._id,
              type:       'Info',
            });
          }
        }
      }
    }

    res.status(200).json({ success: true, message: 'Attendance saved successfully!', count: results.length });
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
      const end   = new Date(year, month, 0);
      filter.date = { $gte: start, $lte: end };
    }
    const records    = await Attendance.find(filter).sort({ date: -1 });
    const total      = records.length;
    const present    = records.filter(r => r.status === 'Present').length;
    const absent     = records.filter(r => r.status === 'Absent').length;
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
    const records    = await Attendance.find({ studentId: student._id }).sort({ date: -1 });
    const total      = records.length;
    const present    = records.filter(r => r.status === 'Present').length;
    const absent     = records.filter(r => r.status === 'Absent').length;
    const percentage = total > 0 ? ((present / total) * 100).toFixed(1) : 0;
    res.status(200).json({
      success: true,
      data: { total, present, absent, percentage: parseFloat(percentage) }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

const getChildAttendanceSummary = async (req, res) => {
  try {
    const parent = await Parent.findOne({ userId: req.user._id }).populate('children');
    if (!parent || !parent.children.length) {
      return res.status(404).json({ success: false, message: 'No child linked to this account' });
    }
    const studentId  = parent.children[0]._id;
    const records    = await Attendance.find({ studentId });
    const total      = records.length;
    const present    = records.filter(r => r.status === 'Present').length;
    const absent     = records.filter(r => r.status === 'Absent').length;
    const late       = records.filter(r => r.status === 'Late').length;
    const leave      = records.filter(r => r.status === 'Leave').length;
    const percentage = total > 0 ? Math.round((present / total) * 100) : 0;
    res.status(200).json({
      success: true,
      data: { present, absent, late, leave, total, percentage }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

const getChildAttendanceRecords = async (req, res) => {
  try {
    const parent = await Parent.findOne({ userId: req.user._id }).populate('children');
    if (!parent || !parent.children.length) {
      return res.status(404).json({ success: false, message: 'No child linked to this account' });
    }
    const studentId = parent.children[0]._id;
    const records   = await Attendance.find({ studentId }).sort({ date: -1 });
    res.status(200).json({ success: true, data: records });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

module.exports = {
  markAttendance,
  markBulkAttendance,
  getStudentAttendance,
  getClassAttendance,
  getMyAttendanceSummary,
  getChildAttendanceSummary,
  getChildAttendanceRecords,
};