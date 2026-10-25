const Complaint = require('../models/Complaint');
const Student = require('../models/Student');
const { HttpError, asyncHandler, assertId } = require('../utils/http');
const { canAccessStudent, resolveChild, parentUserIdsForStudent } = require('../services/directory');
const { notifyParents, notifyUser } = require('../services/notify');
const { scopeOf } = require('../services/authorization');

const CATEGORIES = ['Behaviour', 'Studies', 'Attendance', 'Fees', 'Other'];
const clean = (v, max) => String(v ?? '').trim().slice(0, max);

const present = (c, student) => {
  const o = c.toObject ? c.toObject() : c;
  return {
    _id: o._id, category: o.category, subject: o.subject, details: o.details, status: o.status, raisedBy: o.raisedBy, createdAt: o.createdAt, resolvedAt: o.resolvedAt,
    responses: (o.responses || []).map((r) => ({ byName: r.byName, role: r.role, text: r.text, at: r.at })),
    student: student ? { _id: student._id, name: student.name, class: student.class, section: student.section } : undefined,
  };
};

// POST /api/complaints (staff, for a student they may see): the parents are told
const create = asyncHandler(async (req, res) => {
  const { studentId } = req.body || {};
  assertId(studentId, 'studentId');
  const subject = clean(req.body.subject, 200);
  if (!subject) throw new HttpError(400, 'Write what the concern is about');
  const student = await Student.findOne({ _id: studentId, school: req.schoolId, isActive: true });
  if (!student || !(await canAccessStudent(req.user, student))) throw new HttpError(404, 'Student not found');
  const category = CATEGORIES.includes(req.body.category) ? req.body.category : 'Other';
  const c = await Complaint.create({ school: req.schoolId, student: student._id, category, subject, details: clean(req.body.details, 4000), createdBy: req.user._id, raisedBy: req.user.name });
  notifyParents(student, { title: `Message from school about ${student.name}`, message: subject, type: 'Complaint', createdBy: req.user._id }).catch(() => {});
  res.status(201).json({ success: true, data: present(c, student) });
});

// GET /api/complaints?status=&studentId= (staff: a teacher sees the ones they raised, the office sees all)
const listForStaff = asyncHandler(async (req, res) => {
  const filter = { school: req.schoolId };
  if (scopeOf(req.user, 'academic') !== 'school') filter.createdBy = req.user._id;
  if (['open', 'acknowledged', 'resolved'].includes(req.query.status)) filter.status = req.query.status;
  if (req.query.studentId) { assertId(req.query.studentId); filter.student = req.query.studentId; }
  const list = await Complaint.find(filter).sort({ createdAt: -1 }).limit(200);
  const students = new Map((await Student.find({ school: req.schoolId, _id: { $in: list.map((c) => c.student) } }).select('name class section')).map((s) => [String(s._id), s]));
  res.json({ success: true, data: list.map((c) => present(c, students.get(String(c.student)))) });
});

// GET /api/complaints/child?studentId= (parent)
const ofChild = asyncHandler(async (req, res) => {
  const { child } = await resolveChild(req.user, req.query.studentId);
  if (!child) throw new HttpError(404, 'No student linked to this account');
  const list = await Complaint.find({ school: req.schoolId, student: child._id }).sort({ createdAt: -1 }).limit(100);
  res.json({ success: true, data: list.map((c) => present(c, child)), student: { _id: child._id, name: child.name } });
});

async function loadFor(req) {
  assertId(req.params.id);
  const c = await Complaint.findOne({ _id: req.params.id, school: req.schoolId });
  if (!c) throw new HttpError(404, 'Not found');
  const student = await Student.findOne({ _id: c.student, school: req.schoolId });
  const isParent = req.user.role === 'parent' && student && (await parentUserIdsForStudent(student)).includes(String(req.user._id));
  const isStaff = !isParent && (String(c.createdBy) === String(req.user._id) || scopeOf(req.user, 'academic') === 'school');
  if (!isParent && !isStaff) throw new HttpError(404, 'Not found');
  return { c, student, isParent };
}

// POST /api/complaints/:id/reply { text } (the child's parent, or the staff member who raised it / the office)
const reply = asyncHandler(async (req, res) => {
  const { c, student, isParent } = await loadFor(req);
  const text = clean(req.body?.text, 2000);
  if (!text) throw new HttpError(400, 'Write your reply');
  c.responses.push({ by: req.user._id, byName: req.user.name, role: req.user.role, text });
  if (isParent && c.status === 'open') c.status = 'acknowledged';
  await c.save();
  if (isParent) await notifyUser(req.schoolId, c.createdBy, { title: `${req.user.name} replied about ${student.name}`, message: text.slice(0, 200), type: 'Complaint', createdBy: req.user._id }).catch(() => {});
  else notifyParents(student, { title: `Reply from school about ${student.name}`, message: text.slice(0, 200), type: 'Complaint', createdBy: req.user._id }).catch(() => {});
  res.json({ success: true, data: present(c, student) });
});

// PATCH /api/complaints/:id { status } (staff who raised it, or the office)
const setStatus = asyncHandler(async (req, res) => {
  const { c, student, isParent } = await loadFor(req);
  if (isParent) throw new HttpError(403, 'Only the school can close a concern');
  if (!['open', 'acknowledged', 'resolved'].includes(req.body?.status)) throw new HttpError(400, 'Choose open, acknowledged or resolved');
  c.status = req.body.status;
  c.resolvedAt = c.status === 'resolved' ? new Date() : null;
  await c.save();
  res.json({ success: true, data: present(c, student) });
});

module.exports = { create, listForStaff, ofChild, reply, setStatus };
