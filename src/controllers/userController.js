const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { jwtSecret } = require('../config/env');
const { HttpError, asyncHandler, assertId, escapeRegex } = require('../utils/http');
const { temporaryPassword, hashPassword, validatePasswordStrength } = require('../services/credentials');

const { ASSIGNABLE_ROLES, permissionsFor } = require('../config/permissions');

const publicUser = (user) => ({
  _id: user._id,
  name: user.name,
  email: user.email,
  role: user.role,
  school: user.school?.name || null,
  schoolId: user.school?._id || user.school || null,
  profileId: user.profileId,
  mustChangePassword: !!user.mustChangePassword,
  permissions: permissionsFor(user.role),
});

// POST /api/users/login
const loginUser = asyncHandler(async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  if (!email || !password) throw new HttpError(400, 'Email and password are required');

  const user = await User.findOne({ email }).populate('school', 'name isActive');
  // Same message for unknown email and wrong password (prevents account discovery).
  const valid = user && (await user.comparePassword(password));
  if (!valid) throw new HttpError(401, 'Invalid email or password');
  if (!user.isActive) throw new HttpError(403, 'This account has been deactivated. Please contact your school.');
  if (!user.school || user.school.isActive === false) throw new HttpError(403, 'This school account is not active');

  user.lastLoginAt = new Date();
  await user.save();

  const token = jwt.sign({ id: user._id, role: user.role }, jwtSecret(), { expiresIn: process.env.JWT_EXPIRES_IN || '7d' });
  res.json({ success: true, token, user: publicUser(user) });
});

// POST /api/users/register  (admin only — creates an account inside the admin's own school)
const registerUser = asyncHandler(async (req, res) => {
  const { name, role, phone } = req.body || {};
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!name || !email || !role) throw new HttpError(400, 'Name, email and role are required');
  if (!ASSIGNABLE_ROLES.includes(role)) {
    throw new HttpError(400, 'Only admin and accountant logins can be created here. Add students, parents and teachers from their own screens.');
  }
  if (await User.exists({ email })) throw new HttpError(409, 'Email already registered');

  let password = req.body.password;
  let generated = false;
  if (password) {
    const problem = validatePasswordStrength(password);
    if (problem) throw new HttpError(400, problem);
  } else {
    password = temporaryPassword();
    generated = true;
  }

  const user = await User.create({
    name, email, role, phone: phone || null,
    password: await hashPassword(password),
    school: req.schoolId,
    mustChangePassword: true,
  });

  res.status(201).json({
    success: true,
    data: { _id: user._id, name: user.name, email: user.email, role: user.role },
    credentials: generated ? { email, password } : undefined,
  });
});

// GET /api/users/profile
const getProfile = asyncHandler(async (req, res) => {
  res.json({ success: true, data: publicUser(req.user) });
});

// PATCH /api/users/password
const changePassword = asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  const problem = validatePasswordStrength(newPassword);
  if (problem) throw new HttpError(400, problem);

  const user = await User.findById(req.user._id);
  if (!(await user.comparePassword(String(currentPassword || '')))) throw new HttpError(400, 'Current password is incorrect');
  if (await user.comparePassword(newPassword)) throw new HttpError(400, 'New password must be different from the current one');

  user.password = await hashPassword(newPassword);
  user.mustChangePassword = false;
  user.passwordChangedAt = new Date();
  await user.save();

  const token = jwt.sign({ id: user._id, role: user.role }, jwtSecret(), { expiresIn: process.env.JWT_EXPIRES_IN || '7d' });
  res.json({ success: true, message: 'Password updated', token });
});

// POST /api/users/:id/reset-password  (admin: issue a new temporary password)
const resetPassword = asyncHandler(async (req, res) => {
  assertId(req.params.id);
  const user = await User.findOne({ _id: req.params.id, school: req.schoolId });
  if (!user) throw new HttpError(404, 'User not found');
  const password = temporaryPassword();
  user.password = await hashPassword(password);
  user.mustChangePassword = true;
  user.passwordChangedAt = new Date();
  await user.save();
  res.json({ success: true, credentials: { email: user.email, password } });
});

// PATCH /api/users/fcm-token
const updateFcmToken = asyncHandler(async (req, res) => {
  const { fcmToken } = req.body || {};
  if (!fcmToken) throw new HttpError(400, 'fcmToken is required');
  await User.updateOne({ _id: req.user._id }, { fcmToken });
  res.json({ success: true, message: 'Device registered for notifications' });
});

// GET /api/users  (admin: users of own school)
const getAllUsers = asyncHandler(async (req, res) => {
  const { role, search } = req.query;
  const filter = { school: req.schoolId };
  if (role && role !== 'all') filter.role = String(role);
  if (search) filter.$or = [
    { name: { $regex: escapeRegex(search), $options: 'i' } },
    { email: { $regex: escapeRegex(search), $options: 'i' } },
  ];
  const users = await User.find(filter).select('-password -fcmToken').populate('school', 'name').sort({ createdAt: -1 });
  res.json({ success: true, count: users.length, data: users });
});

// PATCH /api/users/:id/toggle
const toggleUserStatus = asyncHandler(async (req, res) => {
  assertId(req.params.id);
  if (String(req.params.id) === String(req.user._id)) throw new HttpError(400, 'You cannot deactivate your own account');
  const user = await User.findOne({ _id: req.params.id, school: req.schoolId });
  if (!user) throw new HttpError(404, 'User not found');
  user.isActive = !user.isActive;
  await user.save();
  res.json({ success: true, data: { _id: user._id, isActive: user.isActive } });
});

module.exports = {
  loginUser, registerUser, getProfile, changePassword, resetPassword,
  updateFcmToken, getAllUsers, toggleUserStatus,
};
