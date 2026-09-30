const Teacher = require('../models/Teacher');
const User = require('../models/User');
const { HttpError, asyncHandler, assertId, escapeRegex } = require('../utils/http');
const { classKey, parseClassKey, normalizeClass } = require('../utils/classes');
const { createTeacherWithAccount, normalizeTeacherInput } = require('../services/teacherService');
const { teacherForUser } = require('../services/directory');

// GET /api/teachers/me
exports.getMe = asyncHandler(async (req, res) => {
  const teacher = await teacherForUser(req.user);
  if (!teacher) throw new HttpError(404, 'Teacher profile not found');
  res.json({ success: true, data: teacher });
});

// GET /api/teachers
exports.getTeachers = asyncHandler(async (req, res) => {
  const { subject, search } = req.query;
  const query = { school: req.schoolId, isActive: true };
  if (subject) query.subjects = String(subject);
  if (search) query.name = { $regex: escapeRegex(search), $options: 'i' };
  const projection = req.user.role === 'admin' ? '' : '-salary -dateOfBirth -address';
  const teachers = await Teacher.find(query).select(projection).sort({ name: 1 });
  res.json({ success: true, count: teachers.length, data: teachers });
});

// GET /api/teachers/:id
exports.getTeacher = asyncHandler(async (req, res) => {
  assertId(req.params.id);
  const projection = req.user.role === 'admin' ? '' : '-salary -dateOfBirth -address';
  const teacher = await Teacher.findOne({ _id: req.params.id, school: req.schoolId }).select(projection);
  if (!teacher) throw new HttpError(404, 'Teacher not found');
  res.json({ success: true, data: teacher });
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
  res.json({ success: true, count: teachers.length, data: teachers });
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
    await User.updateOne({ _id: teacher.userId }, { ...(update.name && { name: update.name }), ...(update.phone && { phone: update.phone }) });
  }
  res.json({ success: true, message: 'Teacher updated successfully', data: teacher });
});

// PATCH /api/teachers/:id/assign-class   body: { className: "10-A" }
exports.assignClass = asyncHandler(async (req, res) => {
  assertId(req.params.id);
  const parsed = parseClassKey(req.body?.className, req.body?.section);
  if (!parsed.class) throw new HttpError(400, 'className is required');
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
  res.json({ success: true, data: teacher });
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
  if (teacher.userId) await User.updateOne({ _id: teacher.userId }, { isActive: false });
  res.json({ success: true, message: 'Teacher deactivated successfully' });
});
