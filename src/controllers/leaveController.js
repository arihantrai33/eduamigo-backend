const LeaveRequest = require('../models/LeaveRequest');
const { HttpError, asyncHandler, assertId } = require('../utils/http');
const { toDayKey, daysBetweenInclusive, currentAcademicYear } = require('../utils/dates');
const { teacherCoversClass } = require('../utils/classes');
const Student = require('../models/Student');
const { studentForUser, resolveChild, teacherForUser } = require('../services/directory');
const { notifyParents, notifyUser } = require('../services/notify');

const LEAVE_QUOTA_DAYS = Number(process.env.LEAVE_QUOTA_DAYS || 12);
const TYPES = ['Sick', 'Personal', 'Family', 'Other'];

function academicYearRange(now = new Date()) {
  const startYear = Number(currentAcademicYear(now).slice(0, 4));
  return { $gte: new Date(Date.UTC(startYear, 3, 1)), $lt: new Date(Date.UTC(startYear + 1, 3, 1)) };
}

// POST /api/leaves/apply
// Students apply for themselves; parents apply for a child (body.studentId, defaults to first child);
// teachers/admins apply for themselves.
const applyLeave = asyncHandler(async (req, res) => {
  const { leaveType, fromDate, toDate, reason } = req.body || {};
  if (!fromDate || !toDate || !reason || !leaveType) throw new HttpError(400, 'Leave type, dates and reason are required');
  if (!TYPES.includes(leaveType)) throw new HttpError(400, 'Invalid leave type');
  const from = toDayKey(fromDate);
  const to = toDayKey(toDate);
  if (!from || !to) throw new HttpError(400, 'Invalid dates');
  if (to < from) throw new HttpError(400, 'End date cannot be before start date');
  const days = daysBetweenInclusive(from, to);
  const attachmentUrl = req.body.attachmentUrl ? String(req.body.attachmentUrl) : null;
  if (attachmentUrl && !/^https:\/\//i.test(attachmentUrl)) throw new HttpError(400, 'Invalid attachment link');
  if (days > 60) throw new HttpError(400, 'A single leave request cannot exceed 60 days');

  let student = null;
  if (req.user.role === 'student') student = await studentForUser(req.user);
  if (req.user.role === 'parent') {
    ({ child: student } = await resolveChild(req.user, req.body.studentId));
    if (!student) throw new HttpError(404, 'No child is linked to this account');
  }

  const leave = await LeaveRequest.create({
    school: req.schoolId,
    requestedBy: req.user._id,
    role: req.user.role,
    name: student ? student.name : req.user.name,
    studentId: student?._id || null,
    class: student?.class,
    section: student?.section,
    leaveType, fromDate: from, toDate: to, days, reason,
    attachmentUrl, attachmentName: attachmentUrl ? String(req.body.attachmentName || 'Attachment').slice(0, 200) : null,
  });

  if (student && req.user.role === 'student') {
    await notifyParents(student, {
      title: 'Leave request submitted',
      message: `${student.name} requested leave from ${from.toISOString().slice(0, 10)} to ${to.toISOString().slice(0, 10)}. Status: Pending.`,
      type: 'Leave', createdBy: req.user._id,
    });
  }
  res.status(201).json({ success: true, message: 'Leave request submitted successfully', data: leave });
});

// GET /api/leaves/my
const getMyLeaves = asyncHandler(async (req, res) => {
  const leaves = await LeaveRequest.find({ school: req.schoolId, requestedBy: req.user._id }).sort({ createdAt: -1 });
  res.json({ success: true, data: leaves });
});

// GET /api/leaves/quota — approved leave days used in the current academic year
const getMyQuota = asyncHandler(async (req, res) => {
  const approved = await LeaveRequest.find({
    school: req.schoolId, requestedBy: req.user._id, status: 'Approved', fromDate: academicYearRange(),
  }).select('days');
  const used = approved.reduce((s, l) => s + (l.days || 1), 0);
  res.json({ success: true, data: { total: LEAVE_QUOTA_DAYS, used, available: Math.max(0, LEAVE_QUOTA_DAYS - used) } });
});

// Teachers review student leaves for their own classes; admins review everything in the school.
async function reviewScope(req) {
  const filter = { school: req.schoolId };
  if (req.user.role === 'teacher') {
    const teacher = await teacherForUser(req.user);
    filter.studentId = { $ne: null };
    return { filter, teacher };
  }
  return { filter };
}

// GET /api/leaves (admin)
const getAllLeaves = asyncHandler(async (req, res) => {
  const filter = { school: req.schoolId };
  if (req.query.status) filter.status = String(req.query.status);
  if (req.query.role) filter.role = String(req.query.role);
  const leaves = await LeaveRequest.find(filter).sort({ createdAt: -1 }).limit(1000);
  res.json({ success: true, count: leaves.length, data: leaves });
});

// GET /api/leaves/pending (admin, teacher)
const getAllPendingLeaves = asyncHandler(async (req, res) => {
  const { filter, teacher } = await reviewScope(req);
  let leaves = await LeaveRequest.find({ ...filter, status: 'Pending' }).sort({ createdAt: -1 });
  if (teacher) leaves = leaves.filter((l) => teacherCoversClass(teacher, l.class, l.section));
  res.json({ success: true, count: leaves.length, data: leaves });
});

// PATCH /api/leaves/:id/review
const reviewLeave = asyncHandler(async (req, res) => {
  assertId(req.params.id);
  const { status, reviewNote } = req.body || {};
  if (!['Approved', 'Rejected'].includes(status)) throw new HttpError(400, 'Status must be Approved or Rejected');

  const leave = await LeaveRequest.findOne({ _id: req.params.id, school: req.schoolId });
  if (!leave) throw new HttpError(404, 'Leave request not found');
  if (req.user.role === 'teacher') {
    const teacher = await teacherForUser(req.user);
    if (!leave.studentId || !teacherCoversClass(teacher, leave.class, leave.section)) {
      throw new HttpError(403, 'You can only review leave requests for students in your classes');
    }
  }
  if (String(leave.requestedBy) === String(req.user._id)) throw new HttpError(403, 'You cannot review your own leave request');
  if (leave.status !== 'Pending') throw new HttpError(409, 'This leave request has already been reviewed');

  leave.status = status;
  leave.reviewNote = reviewNote || '';
  leave.reviewedBy = req.user._id;
  leave.reviewedAt = new Date();
  await leave.save();

  const msg = {
    title: `Leave ${status.toLowerCase()}`,
    message: `Leave request for ${leave.name} (${leave.fromDate.toISOString().slice(0, 10)} to ${leave.toDate.toISOString().slice(0, 10)}) was ${status.toLowerCase()}.${reviewNote ? ` Note: ${reviewNote}` : ''}`,
    type: 'Leave', createdBy: req.user._id,
  };
  await notifyUser(req.schoolId, leave.requestedBy, msg);
  if (leave.studentId && leave.role === 'student') {
    const student = await Student.findById(leave.studentId);
    if (student) await notifyParents(student, msg);
  }
  res.json({ success: true, message: `Leave ${status.toLowerCase()} successfully`, data: leave });
});

// DELETE /api/leaves/:id (admin, reviewed requests only)
const deleteLeave = asyncHandler(async (req, res) => {
  assertId(req.params.id);
  const leave = await LeaveRequest.findOne({ _id: req.params.id, school: req.schoolId });
  if (!leave) throw new HttpError(404, 'Leave request not found');
  if (leave.status === 'Pending') throw new HttpError(409, 'Pending leave requests cannot be deleted');
  await leave.deleteOne();
  res.json({ success: true, message: 'Leave deleted successfully' });
});

module.exports = { applyLeave, getMyLeaves, getMyQuota, getAllLeaves, getAllPendingLeaves, reviewLeave, deleteLeave };
