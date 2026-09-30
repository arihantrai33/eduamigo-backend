const Teacher = require('../models/Teacher');
const Salary = require('../models/Salary');
const StaffLeave = require('../models/StaffLeave');
const { HttpError, asyncHandler, assertId, pick } = require('../utils/http');

const SALARY_FIELDS = ['basicSalary', 'allowances', 'deductions', 'status', 'paidOn', 'remarks'];
const LEAVE_FIELDS = ['leaveType', 'fromDate', 'toDate', 'reason', 'status', 'remarks'];

async function assertTeacher(school, teacherId) {
  assertId(teacherId, 'teacher');
  if (!(await Teacher.exists({ _id: teacherId, school }))) throw new HttpError(400, 'Teacher does not belong to your school');
}

// --- SALARY ---
const getSalaries = asyncHandler(async (req, res) => {
  const filter = { school: req.schoolId };
  if (req.query.month) filter.month = Number(req.query.month);
  if (req.query.year) filter.year = Number(req.query.year);
  if (req.query.teacherId) { assertId(req.query.teacherId, 'teacherId'); filter.teacher = req.query.teacherId; }
  const salaries = await Salary.find(filter).populate('teacher', 'name employeeId subjects').sort({ createdAt: -1 });
  res.json({ success: true, data: salaries });
});

const createSalary = asyncHandler(async (req, res) => {
  const teacherId = req.body?.teacher || req.body?.teacherId;
  await assertTeacher(req.schoolId, teacherId);
  const salary = await Salary.create({
    ...pick(req.body, SALARY_FIELDS),
    month: Number(req.body.month), year: Number(req.body.year),
    teacher: teacherId, school: req.schoolId,
  });
  await salary.populate('teacher', 'name employeeId');
  res.status(201).json({ success: true, data: salary });
});

const updateSalary = asyncHandler(async (req, res) => {
  assertId(req.params.id);
  const salary = await Salary.findOne({ _id: req.params.id, school: req.schoolId });
  if (!salary) throw new HttpError(404, 'Salary record not found');
  Object.assign(salary, pick(req.body, SALARY_FIELDS));
  if (salary.status === 'Paid' && !salary.paidOn) salary.paidOn = new Date();
  await salary.save(); // recalculates netSalary
  await salary.populate('teacher', 'name employeeId');
  res.json({ success: true, data: salary });
});

const deleteSalary = asyncHandler(async (req, res) => {
  assertId(req.params.id);
  const salary = await Salary.findOne({ _id: req.params.id, school: req.schoolId });
  if (!salary) throw new HttpError(404, 'Salary record not found');
  if (salary.status === 'Paid') throw new HttpError(409, 'Paid salary records cannot be deleted');
  await salary.deleteOne();
  res.json({ success: true, message: 'Deleted' });
});

const generateMonthlySalaries = asyncHandler(async (req, res) => {
  const month = Number(req.body?.month);
  const year = Number(req.body?.year);
  if (!(month >= 1 && month <= 12) || !(year > 2000)) throw new HttpError(400, 'Valid month and year are required');
  const teachers = await Teacher.find({ school: req.schoolId, isActive: true });
  const existing = await Salary.find({ month, year, school: req.schoolId }).select('teacher');
  const have = new Set(existing.map((s) => String(s.teacher)));
  const records = teachers.filter((t) => !have.has(String(t._id))).map((t) => ({
    teacher: t._id, month, year, basicSalary: t.salary || 0, allowances: 0, deductions: 0,
    netSalary: t.salary || 0, school: req.schoolId,
  }));
  if (records.length) await Salary.insertMany(records);
  res.json({ success: true, message: `Generated salary for ${records.length} teacher(s)`, data: records.length });
});

// --- STAFF LEAVES ---
const getStaffLeaves = asyncHandler(async (req, res) => {
  const filter = { school: req.schoolId };
  if (req.query.status) filter.status = String(req.query.status);
  if (req.query.teacherId) { assertId(req.query.teacherId, 'teacherId'); filter.teacher = req.query.teacherId; }
  const leaves = await StaffLeave.find(filter).populate('teacher', 'name employeeId').sort({ createdAt: -1 });
  res.json({ success: true, data: leaves });
});

const createStaffLeave = asyncHandler(async (req, res) => {
  const teacherId = req.body?.teacher || req.body?.teacherId;
  await assertTeacher(req.schoolId, teacherId);
  const data = pick(req.body, LEAVE_FIELDS);
  if (data.fromDate && data.toDate && new Date(data.toDate) < new Date(data.fromDate)) throw new HttpError(400, 'End date cannot be before start date');
  const leave = await StaffLeave.create({ ...data, teacher: teacherId, school: req.schoolId });
  await leave.populate('teacher', 'name employeeId');
  res.status(201).json({ success: true, data: leave });
});

const updateStaffLeave = asyncHandler(async (req, res) => {
  assertId(req.params.id);
  const leave = await StaffLeave.findOne({ _id: req.params.id, school: req.schoolId });
  if (!leave) throw new HttpError(404, 'Leave record not found');
  Object.assign(leave, pick(req.body, LEAVE_FIELDS));
  if (req.body?.status) leave.approvedBy = req.user._id;
  await leave.save();
  await leave.populate('teacher', 'name employeeId');
  res.json({ success: true, data: leave });
});

const deleteStaffLeave = asyncHandler(async (req, res) => {
  assertId(req.params.id);
  const leave = await StaffLeave.findOneAndDelete({ _id: req.params.id, school: req.schoolId });
  if (!leave) throw new HttpError(404, 'Leave record not found');
  res.json({ success: true, message: 'Deleted' });
});

module.exports = {
  getSalaries, createSalary, updateSalary, deleteSalary, generateMonthlySalaries,
  getStaffLeaves, createStaffLeave, updateStaffLeave, deleteStaffLeave,
};
