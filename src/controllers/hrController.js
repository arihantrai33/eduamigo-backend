const Teacher = require("../models/Teacher");
const Salary = require("../models/Salary");
const StaffLeave = require("../models/StaffLeave");

// --- SALARY ---
const getSalaries = async (req, res) => {
  try {
    const { month, year, teacherId } = req.query;
    const filter = { school: req.user.schoolId };
    if (month) filter.month = month;
    if (year) filter.year = year;
    if (teacherId) filter.teacher = teacherId;
    const salaries = await Salary.find(filter).populate("teacher", "name employeeId subjects").sort({ createdAt: -1 });
    res.json({ success: true, data: salaries });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

const createSalary = async (req, res) => {
  try {
    const salary = await Salary.create({ ...req.body, school: req.user.schoolId });
    await salary.populate("teacher", "name employeeId");
    res.status(201).json({ success: true, data: salary });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

const updateSalary = async (req, res) => {
  try {
    const salary = await Salary.findByIdAndUpdate(req.params.id, req.body, { new: true }).populate("teacher", "name employeeId");
    res.json({ success: true, data: salary });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

const deleteSalary = async (req, res) => {
  try {
    await Salary.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: "Deleted" });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

const generateMonthlySalaries = async (req, res) => {
  try {
    const { month, year } = req.body;
    const teachers = await Teacher.find({ school: req.user.schoolId, isActive: true });
    const existing = await Salary.find({ month, year, school: req.user.schoolId }).select("teacher");
    const existingIds = existing.map(s => s.teacher.toString());
    const toCreate = teachers.filter(t => !existingIds.includes(t._id.toString()));
    const records = toCreate.map(t => ({
      teacher: t._id, month, year,
      basicSalary: t.salary || 0,
      allowances: 0, deductions: 0,
      netSalary: t.salary || 0,
      school: req.user.schoolId
    }));
    await Salary.insertMany(records);
    res.json({ success: true, message: `Generated salary for ${records.length} teachers`, data: records.length });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

// --- STAFF LEAVES ---
const getStaffLeaves = async (req, res) => {
  try {
    const { status, teacherId } = req.query;
    const filter = { school: req.user.schoolId };
    if (status) filter.status = status;
    if (teacherId) filter.teacher = teacherId;
    const leaves = await StaffLeave.find(filter).populate("teacher", "name employeeId").sort({ createdAt: -1 });
    res.json({ success: true, data: leaves });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

const createStaffLeave = async (req, res) => {
  try {
    const leave = await StaffLeave.create({ ...req.body, school: req.user.schoolId });
    await leave.populate("teacher", "name employeeId");
    res.status(201).json({ success: true, data: leave });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

const updateStaffLeave = async (req, res) => {
  try {
    if (req.body.status) req.body.approvedBy = req.user.id;
    const leave = await StaffLeave.findByIdAndUpdate(req.params.id, req.body, { new: true }).populate("teacher", "name employeeId");
    res.json({ success: true, data: leave });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

const deleteStaffLeave = async (req, res) => {
  try {
    await StaffLeave.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: "Deleted" });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

module.exports = { getSalaries, createSalary, updateSalary, deleteSalary, generateMonthlySalaries, getStaffLeaves, createStaffLeave, updateStaffLeave, deleteStaffLeave };
