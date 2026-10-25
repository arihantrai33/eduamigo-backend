const Teacher = require('../models/Teacher');
const User = require('../models/User');
const { withPhotos } = require('../services/avatars');
const { HttpError, asyncHandler, assertId, escapeRegex } = require('../utils/http');
const { classKey, parseClassKey, normalizeClass } = require('../utils/classes');
const { createTeacherWithAccount, normalizeTeacherInput } = require('../services/teacherService');
const { teacherForUser } = require('../services/directory');
const { assertClassSection } = require('../services/academic');
const { can } = require('../services/authorization');
const { assignmentsOf, replaceAssignments } = require('../services/teaching');
const TeachingAssignment = require('../models/TeachingAssignment');
const { audit } = require('../services/audit');

// Salary and personal details are for those who manage staff; everyone else with access to the staff list does not get them.
const staffProjection = (user) => (can(user, 'teachers.manage') ? '' : '-salary -dateOfBirth -address');

// The teacher's own profile photo (set from their account) replaces any older one on the record.
async function photoed(docs, schoolId) {
  const list = Array.isArray(docs) ? docs : [docs];
  const rows = await Teacher.find({ _id: { $in: list.map((d) => d._id) }, school: schoolId }).select('userId').lean();
  const owner = new Map(rows.map((r) => [String(r._id), r.userId]));
  return withPhotos(docs, (d) => owner.get(String(d._id)), schoolId);
}

// GET /api/teachers/me
exports.getMe = asyncHandler(async (req, res) => {
  const teacher = await teacherForUser(req.user);
  if (!teacher) throw new HttpError(404, 'Teacher profile not found');
  res.json({ success: true, data: await photoed(teacher, req.schoolId) });
});

// GET /api/teachers
exports.getTeachers = asyncHandler(async (req, res) => {
  const { subject, search } = req.query;
  const query = { school: req.schoolId, isActive: true };
  if (subject) query.subjects = String(subject);
  if (search) query.name = { $regex: escapeRegex(search), $options: 'i' };
  const projection = staffProjection(req.user);
  const teachers = await Teacher.find(query).select(projection).sort({ name: 1 });
  res.json({ success: true, count: teachers.length, data: await photoed(teachers, req.schoolId) });
});

// GET /api/teachers/:id
exports.getTeacher = asyncHandler(async (req, res) => {
  assertId(req.params.id);
  const projection = staffProjection(req.user);
  const teacher = await Teacher.findOne({ _id: req.params.id, school: req.schoolId }).select(projection);
  if (!teacher) throw new HttpError(404, 'Teacher not found');
  res.json({ success: true, data: await photoed(teacher, req.schoolId) });
});

// GET /api/teachers/class/:class — teachers of a class ("10" or "10-A")
exports.getTeachersByClass = asyncHandler(async (req, res) => {
  const { class: cls, section } = parseClassKey(req.params.class, req.query.section);
  const keys = section ? [classKey(cls, section), cls] : [cls];
  const teachers = await Teacher.find({
    school: req.schoolId, isActive: true,
    $or: [
      { assignedClasses: { $in: keys } },
      ...(section ? [] : [{ assignedClasses: { $regex: `^${normalizeClass(cls).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-` } }]),
    ],
  }).select('name subjects assignedClasses photo userId');
  res.json({ success: true, count: teachers.length, data: await photoed(teachers, req.schoolId) });
});

// POST /api/teachers
exports.createTeacher = asyncHandler(async (req, res) => {
  const { teacher, credentials } = await createTeacherWithAccount(req.schoolId, req.body || {});
  res.status(201).json({ success: true, message: 'Teacher added successfully', data: teacher, credentials });
});

// PUT /api/teachers/:id
exports.updateTeacher = asyncHandler(async (req, res) => {
  assertId(req.params.id);
  const update = normalizeTeacherInput(req.body || {});
  delete update.email; // login email changes go through user management to keep accounts consistent
  const teacher = await Teacher.findOneAndUpdate(
    { _id: req.params.id, school: req.schoolId },
    update,
    { returnDocument: 'after', runValidators: true },
  );
  if (!teacher) throw new HttpError(404, 'Teacher not found');
  if (teacher.userId && (update.name || update.phone)) {
    await User.updateOne({ _id: teacher.userId, school: req.schoolId }, { ...(update.name && { name: update.name }), ...(update.phone && { phone: update.phone }) });
  }
  res.json({ success: true, message: 'Teacher updated successfully', data: teacher });
});

// PATCH /api/teachers/:id/assign-class   body: { className: "10-A" }
exports.assignClass = asyncHandler(async (req, res) => {
  assertId(req.params.id);
  const parsed = parseClassKey(req.body?.className, req.body?.section);
  if (!parsed.class) throw new HttpError(400, 'className is required');
  await assertClassSection(req.schoolId, parsed.class, parsed.section);
  const key = classKey(parsed.class, parsed.section);
  const teacher = await Teacher.findOne({ _id: req.params.id, school: req.schoolId });
  if (!teacher) throw new HttpError(404, 'Teacher not found');
  if (teacher.assignedClasses.includes(key)) throw new HttpError(409, `Class ${key} is already assigned`);
  teacher.assignedClasses.push(key);
  await teacher.save();
  res.json({ success: true, data: teacher });
});

// PATCH /api/teachers/:id/remove-class
exports.removeClass = asyncHandler(async (req, res) => {
  assertId(req.params.id);
  const parsed = parseClassKey(req.body?.className, req.body?.section);
  const key = classKey(parsed.class, parsed.section);
  const teacher = await Teacher.findOne({ _id: req.params.id, school: req.schoolId });
  if (!teacher) throw new HttpError(404, 'Teacher not found');
  teacher.assignedClasses = teacher.assignedClasses.filter((c) => c !== key && c !== req.body?.className);
  await teacher.save();
  // The subjects they taught in that class go with it, so no assignment is left for a class they no longer cover.
  await TeachingAssignment.deleteMany({ school: req.schoolId, teacher: teacher._id, class: parsed.class, ...(parsed.section ? { section: parsed.section } : {}) });
  res.json({ success: true, data: teacher });
});

// GET /api/teachers/:id/assignments
exports.getAssignments = asyncHandler(async (req, res) => {
  assertId(req.params.id);
  const teacher = await Teacher.findOne({ _id: req.params.id, school: req.schoolId }).select('_id');
  if (!teacher) throw new HttpError(404, 'Teacher not found');
  res.json({ success: true, data: await assignmentsOf(req.schoolId, teacher._id) });
});

// PUT /api/teachers/:id/assignments   body: { assignments: [{ class, section, subject, isClassTeacher }] }  (replaces the whole set)
exports.putAssignments = asyncHandler(async (req, res) => {
  assertId(req.params.id);
  const teacher = await Teacher.findOne({ _id: req.params.id, school: req.schoolId });
  if (!teacher) throw new HttpError(404, 'Teacher not found');
  const rows = req.body?.assignments;
  if (Array.isArray(rows)) {
    for (const r of rows) {
      const k = parseClassKey(r?.class, r?.section);
      if (k.class) await assertClassSection(req.schoolId, k.class, k.section);
    }
  }
  const docs = await replaceAssignments(req.schoolId, teacher, rows);
  await audit(req, 'teacher.assignments_changed', { targetType: 'teacher', targetId: teacher._id, details: { count: docs.length } });
  res.json({ success: true, data: docs });
});

// DELETE /api/teachers/:id (soft delete)
exports.deleteTeacher = asyncHandler(async (req, res) => {
  assertId(req.params.id);
  const teacher = await Teacher.findOneAndUpdate(
    { _id: req.params.id, school: req.schoolId },
    { isActive: false },
    { returnDocument: 'after' },
  );
  if (!teacher) throw new HttpError(404, 'Teacher not found');
  if (teacher.userId) await User.updateOne({ _id: teacher.userId, school: req.schoolId }, { isActive: false });
  res.json({ success: true, message: 'Teacher deactivated successfully' });
});
