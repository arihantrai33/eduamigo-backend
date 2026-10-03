const User = require('../models/User');
const { HttpError, asyncHandler, assertId, escapeRegex } = require('../utils/http');
const { temporaryPassword, hashPassword, validatePasswordStrength } = require('../services/credentials');

const { ASSIGNABLE_ROLES, permissionsFor } = require('../config/permissions');
const { PERMISSION_FEATURE } = require('../config/features');
const { entitlementsFor } = require('../services/subscription');
const { signUserToken } = require('../services/tokens');
const accounts = require('../services/accounts');

// Permissions of features the school has not bought are left out, so the apps hide those menus.
const permissionsWithin = (role, entitlements) => permissionsFor(role)
  .filter((p) => !PERMISSION_FEATURE[p] || entitlements.features.includes(PERMISSION_FEATURE[p]));

const publicUser = (user, entitlements) => ({
  _id: user._id,
  name: user.name,
  email: user.email,
  role: user.role,
  school: user.school?.name || null,
  schoolId: user.school?._id || user.school || null,
  schoolCode: user.school?.code || null,
  branding: {
    appName: user.school?.branding?.appName || user.school?.name || '',
    logoUrl: user.school?.branding?.logoUrl || '',
    primaryColor: user.school?.branding?.primaryColor || '',
    accentColor: user.school?.branding?.accentColor || '',
    heroStyle: user.school?.branding?.heroStyle || 'bold',
  },
  profileId: user.profileId,
  mustChangePassword: !!user.mustChangePassword,
  permissions: permissionsWithin(user.role, entitlements),
  features: entitlements.features,
  plan: entitlements.plan,
  subscription: entitlements.state,
});

// Sign-in ID from the request: { email } (old apps) or { schoolCode, identifier }.
function credentialsFrom(body = {}) {
  return {
    email: body.email ? String(body.email) : undefined,
    identifier: body.identifier !== undefined ? String(body.identifier) : undefined,
    schoolCode: body.schoolCode ? String(body.schoolCode) : undefined,
  };
}

// POST /api/users/login
//   { schoolCode, identifier, password }  identifier = admission no (students), mobile (parents) or email (staff)
//   { email, password }                   still supported
const loginUser = asyncHandler(async (req, res) => {
  const credentials = credentialsFrom(req.body);
  const password = String(req.body?.password || '');
  const id = String(credentials.identifier ?? credentials.email ?? '').trim();
  if (!id || !password) throw new HttpError(400, 'Login ID and password are required');
  if (!id.includes('@') && !credentials.schoolCode) throw new HttpError(400, 'Please choose your school first');

  const user = await accounts.authenticate(credentials, password);
  // Same message for unknown accounts and wrong passwords (prevents account discovery).
  if (!user) throw new HttpError(401, id.includes('@') ? 'Invalid email or password' : 'Invalid login ID or password');
  if (!user.isActive) throw new HttpError(403, 'This account has been deactivated. Please contact your school.');
  if (!user.school) throw new HttpError(403, 'This school account is not active');
  const entitlements = await entitlementsFor(user.school);
  if (entitlements.blocked) throw new HttpError(403, 'This school account is not active', { code: 'SCHOOL_SUSPENDED' });

  user.lastLoginAt = new Date();
  await user.save();

  res.json({ success: true, token: signUserToken(user), user: publicUser(user, entitlements) });
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
  res.json({ success: true, data: publicUser(req.user, req.entitlements) });
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

  res.json({ success: true, message: 'Password updated', token: signUserToken(user) });
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
  user.tokenVersion = (user.tokenVersion || 0) + 1;
  await user.save();
  res.json({ success: true, credentials: { email: user.email || null, loginId: await loginIdOf(user), password } });
});

// The ID a person types to sign in: email for staff, admission number for students, mobile for parents.
async function loginIdOf(user) {
  if (user.role === 'student') {
    const student = await require('../models/Student').findOne({ userId: user._id }).select('admissionNo');
    if (student?.admissionNo) return student.admissionNo;
  }
  if (user.role === 'parent' && !user.email && user.loginPhone) return user.loginPhone;
  return user.email || user.loginPhone || null;
}

// POST /api/users/logout-all — signs the user out on every device, including this one
const logoutAll = asyncHandler(async (req, res) => {
  await User.updateOne({ _id: req.user._id }, { $inc: { tokenVersion: 1 } });
  res.json({ success: true, message: 'Signed out of all devices' });
});

const RESET_SENT = 'If this account has an email address, a reset code has been sent to it. Students and accounts without email: please ask your parent, class teacher or school office to reset the password.';

// POST /api/users/forgot-password { email } or { schoolCode, identifier }
const forgotPassword = asyncHandler(async (req, res) => {
  const credentials = credentialsFrom(req.body);
  if (!String(credentials.identifier ?? credentials.email ?? '').trim()) throw new HttpError(400, 'Enter your login ID');
  await accounts.requestPasswordReset(credentials);
  res.json({ success: true, message: RESET_SENT });
});

// POST /api/users/reset-password { email | schoolCode + identifier, code, newPassword }
const resetPasswordWithCode = asyncHandler(async (req, res) => {
  const { code, newPassword } = req.body || {};
  const problem = validatePasswordStrength(newPassword);
  if (problem) throw new HttpError(400, problem);
  const ok = await accounts.resetPasswordWithCode(credentialsFrom(req.body), code, newPassword);
  if (!ok) throw new HttpError(400, 'The code is wrong or has expired. Please request a new one.');
  res.json({ success: true, message: 'Password changed. Please sign in with your new password.' });
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
  loginUser, registerUser, getProfile, changePassword, resetPassword, logoutAll, forgotPassword, resetPasswordWithCode, loginIdOf,
  updateFcmToken, getAllUsers, toggleUserStatus,
};
