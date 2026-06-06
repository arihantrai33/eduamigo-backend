const Student = require("../models/Student");
const Teacher = require("../models/Teacher");
const BulkUpload = require("../models/BulkUpload");

// Bulk attendance mark
const bulkAttendance = async (req, res) => {
  try {
    const { className, section, date, status, studentIds } = req.body;
    const Attendance = require("../models/Attendance");
    const students = studentIds && studentIds.length > 0
      ? await Student.find({ _id: { $in: studentIds } })
      : await Student.find({ class: className, section, school: req.user.schoolId });
    const records = students.map(s => ({
      student: s._id, date: new Date(date), status: status || "Present",
      markedBy: req.user.id, school: req.user.schoolId
    }));
    await Attendance.insertMany(records, { ordered: false }).catch(() => {});
    res.json({ success: true, message: `Attendance marked for ${students.length} students` });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

// Bulk promote students
const bulkPromote = async (req, res) => {
  try {
    const { fromClass, fromSection, toClass, toSection } = req.body;
    const result = await Student.updateMany(
      { class: fromClass, section: fromSection, school: req.user.schoolId },
      { $set: { class: toClass, section: toSection } }
    );
    res.json({ success: true, message: `${result.modifiedCount} students promoted from ${fromClass}-${fromSection} to ${toClass}-${toSection}` });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

// Bulk fee reminder (mark for reminder - actual email/SMS integration later)
const bulkFeeReminder = async (req, res) => {
  try {
    const { studentIds } = req.body;
    const filter = studentIds && studentIds.length > 0
      ? { _id: { $in: studentIds }, school: req.user.schoolId }
      : { feeStatus: { $in: ["Pending", "Partial"] }, school: req.user.schoolId };
    const students = await Student.find(filter).select("name phone parentPhone parentEmail feeStatus");
    res.json({ success: true, message: `Fee reminder prepared for ${students.length} students`, data: students });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

// Bulk CSV upload for students
const bulkUploadStudents = async (req, res) => {
  try {
    const { students } = req.body;
    if (!students || !Array.isArray(students)) return res.status(400).json({ success: false, message: "Invalid data" });
    const errors = [];
    const toInsert = [];
    students.forEach((s, i) => {
      if (!s.name || !s.email || !s.rollNumber || !s.class || !s.section || !s.phone) {
        errors.push({ row: i + 2, message: `Missing required fields` });
      } else {
        toInsert.push({ ...s, school: req.user.schoolId });
      }
    });
    let success = 0;
    for (const s of toInsert) {
      try { await Student.create(s); success++; }
      catch (e) { errors.push({ row: toInsert.indexOf(s) + 2, message: e.message }); }
    }
    const log = await BulkUpload.create({
      type: "students", totalRows: students.length, success, failed: errors.length,
      errors, uploadedBy: req.user.id, school: req.user.schoolId
    });
    res.json({ success: true, data: { total: students.length, success, failed: errors.length, errors } });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

// Bulk CSV upload for teachers
const bulkUploadTeachers = async (req, res) => {
  try {
    const { teachers } = req.body;
    if (!teachers || !Array.isArray(teachers)) return res.status(400).json({ success: false, message: "Invalid data" });
    const errors = [];
    let success = 0;
    for (const [i, t] of teachers.entries()) {
      if (!t.name || !t.email || !t.employeeId || !t.phone) {
        errors.push({ row: i + 2, message: "Missing required fields" }); continue;
      }
      try { await Teacher.create({ ...t, school: req.user.schoolId }); success++; }
      catch (e) { errors.push({ row: i + 2, message: e.message }); }
    }
    res.json({ success: true, data: { total: teachers.length, success, failed: errors.length, errors } });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

module.exports = { bulkAttendance, bulkPromote, bulkFeeReminder, bulkUploadStudents, bulkUploadTeachers };
