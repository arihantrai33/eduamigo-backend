const Parent = require('../models/Parent');
const Student = require('../models/Student');
const User = require('../models/User');
const { HttpError, asyncHandler, assertId } = require('../utils/http');
const { temporaryPassword, hashPassword } = require('../services/credentials');
const { childrenForParent } = require('../services/directory');

// POST /api/parents (admin) — create a parent account and link children of this school
const createParent = asyncHandler(async (req, res) => {
  const { name, phone, gender, address, occupation } = req.body || {};
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!name || !email || !phone) throw new HttpError(400, 'Name, email and phone are required');
  if (await User.exists({ email })) throw new HttpError(409, 'Email already registered');

  const childIds = Array.isArray(req.body.children) ? req.body.children : [];
  childIds.forEach((id) => assertId(id, 'child id'));
  const children = await Student.find({ _id: { $in: childIds }, school: req.schoolId }).select('_id');
  if (children.length !== childIds.length) throw new HttpError(400, 'One or more children do not belong to your school');

  const password = temporaryPassword();
  const user = await User.create({
    name, email, phone, role: 'parent', school: req.schoolId,
    password: await hashPassword(password), mustChangePassword: true,
  });
  try {
    const parent = await Parent.create({
      name, email, phone, gender, address, occupation,
      children: children.map((c) => c._id), school: req.schoolId, userId: user._id,
    });
    await User.updateOne({ _id: user._id }, { profileId: parent._id });
    await Student.updateMany({ _id: { $in: children.map((c) => c._id) }, parentUserId: null }, { parentUserId: user._id });
    res.status(201).json({ success: true, message: 'Parent created successfully', data: parent, credentials: { email, password } });
  } catch (err) {
    await user.deleteOne().catch(() => {});
    throw err;
  }
});

// GET /api/parents/my-child (parent)
const getMyChild = asyncHandler(async (req, res) => {
  const children = await childrenForParent(req.user);
  if (!children.length) throw new HttpError(404, 'No child is linked to this parent');
  const parent = await Parent.findOne({ userId: req.user._id, school: req.schoolId });
  res.json({
    success: true,
    data: {
      parent: {
        name: parent?.name || req.user.name,
        email: parent?.email || req.user.email,
        phone: parent?.phone || req.user.phone,
        gender: parent?.gender,
        address: parent?.address,
        occupation: parent?.occupation,
      },
      children: children.map((c) => ({ _id: c._id, name: c.name, rollNumber: c.rollNumber, class: c.class, section: c.section, photo: c.photo })),
    },
  });
});

// GET /api/parents/:parentId (admin of the same school, or the parent themself)
const getParentById = asyncHandler(async (req, res) => {
  assertId(req.params.parentId);
  const parent = await Parent.findOne({ _id: req.params.parentId, school: req.schoolId })
    .populate('children', 'name rollNumber class section');
  if (!parent) throw new HttpError(404, 'Parent not found');
  if (req.user.role === 'parent' && String(parent.userId) !== String(req.user._id)) {
    throw new HttpError(403, 'You do not have permission to view this parent');
  }
  res.json({ success: true, data: parent });
});

// GET /api/parents/student/:studentId (admin)
const getParentByStudent = asyncHandler(async (req, res) => {
  assertId(req.params.studentId);
  const parent = await Parent.findOne({ children: req.params.studentId, school: req.schoolId })
    .populate('children', 'name rollNumber class section');
  if (!parent) throw new HttpError(404, 'Parent not found');
  res.json({ success: true, data: parent });
});

// GET /api/parents/dashboard/:studentId (admin, or a parent of that student)
const getParentDashboard = asyncHandler(async (req, res) => {
  assertId(req.params.studentId);
  const student = await Student.findOne({ _id: req.params.studentId, school: req.schoolId }).select('name rollNumber class section parentUserId');
  if (!student) throw new HttpError(404, 'Student not found');
  if (req.user.role === 'parent') {
    const mine = await childrenForParent(req.user);
    if (!mine.some((c) => String(c._id) === String(student._id))) throw new HttpError(403, 'You do not have permission to view this student');
  }
  res.json({ success: true, data: { student: { _id: student._id, name: student.name, rollNumber: student.rollNumber, class: student.class, section: student.section } } });
});

// GET /api/parents (admin)
const getAllParents = asyncHandler(async (req, res) => {
  const parents = await Parent.find({ school: req.schoolId })
    .populate('children', 'name rollNumber class section photo')
    .sort({ createdAt: -1 });
  res.json({ success: true, count: parents.length, data: parents });
});

module.exports = { createParent, getAllParents, getMyChild, getParentById, getParentByStudent, getParentDashboard };
