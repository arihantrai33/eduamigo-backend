const ADMIN_ROLE = 'admin'; // the one account type a school may never be left without
const User = require('../models/User');
const push = require('../services/push');
const { HttpError, asyncHandler, assertId, escapeRegex } = require('../utils/http');
const { temporaryPassword, hashPassword, validatePasswordStrength } = require('../services/credentials');

const { ASSIGNABLE_ROLES } = require('../config/permissions');
const { effectivePermissions } = require('../services/authorization');
const { isFullAdministrator, resolveAuthz } = require('../services/roles');
const { entitlementsFor } = require('../services/subscription');
const { signUserToken, signSchoolChoiceTicket, readSchoolChoiceTicket, ticketStillValid } = require('../services/tokens');
const { normalizePhone } = require('../utils/phone');
const { publicProfile } = require('../services/schoolDirectory');
const accounts = require('../services/accounts');
const photos = require('../services/photos');
const { pageParams, paged } = require('../utils/paginate');

// Permissions of features the school has not bought are left out, so the apps hide those menus (the server still checks every request).
const permissionsWithin = (user, entitlements) => effectivePermissions(user, entitlements);

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
  avatar: user.avatarKey ? photos.linkFor(user.avatarKey) : undefined,
  mustChangePassword: !!user.mustChangePassword,
  permissions: permissionsWithin(user, entitlements),
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

// The checks every sign-in passes once the account is known, then the session. The role and the school in the answer are the
// ones stored on the account; nothing the client sent decides them.
async function finishLogin(user, res) {
  if (!user.isActive) throw new HttpError(403, 'This account has been deactivated. Please contact your school.');
  if (!user.school) throw new HttpError(403, 'This school account is not active');
  const entitlements = await entitlementsFor(user.school);
  if (entitlements.blocked) throw new HttpError(403, 'This school account is not active', { code: 'SCHOOL_SUSPENDED' });

  user.lastLoginAt = new Date();
  await user.save();
  user.authz = await resolveAuthz(user); // what the apps are told they may do comes from the same resolution as every request

  res.json({ success: true, token: signUserToken(user), user: publicUser(user, entitlements) });
}

// Accounts that can really sign in (active, school not suspended) among those whose password matched.
async function usableAccounts(users) {
  const usable = [];
  for (const user of users) {
    if (!user.isActive || !user.school) continue;
    if ((await entitlementsFor(user.school)).blocked) continue;
    usable.push(user);
  }
  return usable;
}

// POST /api/users/login
//   { schoolCode, identifier, password }  identifier = admission no (students), mobile (parents) or email (staff)
//   { email, password }                   still supported
//   { identifier, password }              an email, or a mobile number: no school needed (see below)
// A mobile number without a school is looked up in every school. If the password opens one account the person is signed in;
// if it opens accounts in several schools the answer is { requiresSchoolChoice, ticket, schools } and the person picks one
// with POST /api/users/login/school. An admission number still needs its school.
const loginUser = asyncHandler(async (req, res) => {
  const credentials = credentialsFrom(req.body);
  const password = String(req.body?.password || '');
  const id = String(credentials.identifier ?? credentials.email ?? '').trim();
  if (!id || !password) throw new HttpError(400, 'Login ID and password are required');
  const noSchool = !id.includes('@') && !credentials.schoolCode;
  const phone = noSchool ? normalizePhone(id) : '';
  if (noSchool && phone.length !== 10) throw new HttpError(400, 'Please choose your school first');

  if (noSchool) {
    const matched = await accounts.authenticateByPhoneAcrossSchools(phone, password);
    // Same message for an unknown number and a wrong password (prevents account discovery).
    if (!matched.length) throw new HttpError(401, 'Invalid login ID or password');
    const usable = await usableAccounts(matched);
    if (!usable.length) throw new HttpError(403, 'This account is not active. Please contact your school.');
    if (usable.length === 1) return finishLogin(usable[0], res);
    return res.json({
      success: true,
      requiresSchoolChoice: true,
      ticket: signSchoolChoiceTicket(usable),
      schools: usable.map((u) => publicProfile(u.school)),
    });
  }

  const user = await accounts.authenticate(credentials, password);
  // Same message for unknown accounts and wrong passwords (prevents account discovery).
  if (!user) throw new HttpError(401, id.includes('@') ? 'Invalid email or password' : 'Invalid login ID or password');
  return finishLogin(user, res);
});

// POST /api/users/login/school  { ticket, schoolCode }: the second step of a sign-in that matched several schools.
// Only a school on the ticket is accepted, and the account is checked again.
const chooseSchool = asyncHandler(async (req, res) => {
  const { ticket, schoolCode } = req.body || {};
  if (!ticket || !schoolCode) throw new HttpError(400, 'Choose a school to continue');
  const decoded = readSchoolChoiceTicket(ticket);
  if (!decoded) throw new HttpError(401, 'This sign-in has expired. Please sign in again.');
  const wanted = String(schoolCode).trim().toUpperCase();
  const users = await User.find({ _id: { $in: decoded.ids.map((e) => e.id).filter((id) => /^[a-f0-9]{24}$/.test(id)) } })
    .populate('school', 'name code city isActive branding subscription');
  const user = users.find((u) => u.school?.code === wanted);
  const entry = user && decoded.ids.find((e) => String(e.id) === String(user._id));
  if (!user || !entry) throw new HttpError(403, 'That school is not available for this sign-in.');
  if (!ticketStillValid(decoded, entry, user)) throw new HttpError(401, 'This sign-in has expired. Please sign in again.');
  return finishLogin(user, res);
});

// POST /api/users/register  (admin only — creates an account inside the admin's own school)
const registerUser = asyncHandler(async (req, res) => {
  const { name, role, phone } = req.body || {};
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!name || !email || !role) throw new HttpError(400, 'Name, email and role are required');
  if (!ASSIGNABLE_ROLES.includes(role)) {
    throw new HttpError(400, 'Only admin, accountant and other staff logins can be created here. Add students, parents and teachers from their own screens.');
  }
  // Only a full administrator creates administrators: user management alone must not be a way to a bigger role than your own.
  if (role === ADMIN_ROLE && !isFullAdministrator(req.user)) throw new HttpError(403, 'Only a full administrator can create another administrator');
  if (await User.exists({ email }).setOptions({ crossTenant: 'login emails are unique across all schools' })) throw new HttpError(409, 'Email already registered');

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
  // supportSession: signed in by EduAmigo support (platform owner), so the app can show it clearly.
  const data = { ...publicUser(req.user, req.entitlements), supportSession: !!req.impersonatedBy };
  if (req.user.role === 'student' && !data.avatar) {
    const student = await require('../models/Student').findOne({ userId: req.user._id, school: req.schoolId });
    if (student) data.avatar = photos.displayPhoto(student);
  }
  res.json({ success: true, data });
});

// PUT /api/users/me/avatar (multipart "photo"): the signed-in person sets their own profile photo. A student's photo is the
// one on their student record, so the school's lists, the ID card and every portal show it at once.
const setAvatar = asyncHandler(async (req, res) => {
  if (req.impersonatedBy) throw new HttpError(403, 'A support session cannot change a profile photo');
  if (!req.file) throw new HttpError(400, 'Choose a photo (JPEG, PNG or WebP, up to 5 MB)');
  const key = await photos.uploadImage(req.file.buffer, req.schoolId, req.user.role === 'student' ? 'students' : 'avatars');
  try {
    let old = null;
    if (req.user.role === 'student') {
      const Student = require('../models/Student');
      const student = await Student.findOne({ userId: req.user._id, school: req.schoolId }).select('photoKey');
      if (!student) throw new HttpError(404, 'Student record not found');
      old = student.photoKey;
      await Student.updateOne({ _id: student._id, school: req.schoolId }, { $set: { photoKey: key, photo: null } });
    } else {
      const user = await User.findOne({ _id: req.user._id, school: req.schoolId }).select('avatarKey');
      old = user.avatarKey;
      await User.updateOne({ _id: user._id, school: req.schoolId }, { $set: { avatarKey: key } });
    }
    if (old) await photos.removePhoto(old);
  } catch (err) { await photos.removePhoto(key); throw err; }
  res.json({ success: true, avatar: photos.linkFor(key) });
});

// DELETE /api/users/me/avatar
const removeAvatar = asyncHandler(async (req, res) => {
  if (req.impersonatedBy) throw new HttpError(403, 'A support session cannot change a profile photo');
  let old = null;
  if (req.user.role === 'student') {
    const Student = require('../models/Student');
    const student = await Student.findOne({ userId: req.user._id, school: req.schoolId }).select('photoKey');
    old = student?.photoKey;
    if (student) await Student.updateOne({ _id: student._id, school: req.schoolId }, { $set: { photoKey: null, photo: null } });
  } else {
    const user = await User.findOne({ _id: req.user._id, school: req.schoolId }).select('avatarKey');
    old = user.avatarKey;
    await User.updateOne({ _id: user._id, school: req.schoolId }, { $set: { avatarKey: null } });
  }
  if (old) await photos.removePhoto(old);
  res.json({ success: true });
});

// PATCH /api/users/password
const changePassword = asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  const problem = validatePasswordStrength(newPassword);
  if (problem) throw new HttpError(400, problem);

  const user = await User.findOne({ _id: req.user._id, school: req.schoolId });
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
  await User.updateOne({ _id: req.user._id, school: req.schoolId }, { $inc: { tokenVersion: 1 } });
  res.json({ success: true, message: 'Signed out of all devices' });
});

const RESET_SENT = 'If this account has a registered mobile number or email address, a reset code has been sent to it. Students and accounts without email: please ask your parent, class teacher or school office to reset the password.';

// POST /api/users/forgot-password { email } or { schoolCode, identifier }
const forgotPassword = asyncHandler(async (req, res) => {
  const credentials = credentialsFrom(req.body);
  if (!String(credentials.identifier ?? credentials.email ?? '').trim()) throw new HttpError(400, 'Enter your login ID');
  await accounts.requestPasswordReset(credentials);
  res.json({ success: true, message: RESET_SENT });
});

// POST /api/users/otp/request { schoolCode, identifier }: a sign-in code by SMS or email. Always the same answer.
const OTP_SENT = 'If this account exists, a sign-in code has been sent to its registered mobile number or email.';
const requestLoginCode = asyncHandler(async (req, res) => {
  const credentials = credentialsFrom(req.body);
  const id = String(credentials.identifier ?? credentials.email ?? '').trim();
  if (!id) throw new HttpError(400, 'Enter your login ID');
  if (!id.includes('@') && !credentials.schoolCode) throw new HttpError(400, 'Please choose your school first');
  await accounts.requestLoginCode(credentials);
  res.json({ success: true, message: OTP_SENT });
});

// POST /api/users/otp/verify { schoolCode, identifier, code }: signs in with the code instead of a password. A person who proved
// they hold the mobile number or email no longer has to change a temporary password first.
const loginWithCode = asyncHandler(async (req, res) => {
  const credentials = credentialsFrom(req.body);
  const code = String(req.body?.code || '').trim();
  if (!/^\d{6}$/.test(code)) throw new HttpError(400, 'Enter the 6-digit code');
  const user = await accounts.loginWithCode(credentials, code);
  if (!user) throw new HttpError(401, 'That code is wrong or has expired. Please ask for a new one.');
  if (user.mustChangePassword) { user.mustChangePassword = false; await user.save(); }
  return finishLogin(user, res);
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
// PATCH /api/users/fcm-token { fcmToken, platform } — this device receives push notifications for this person.
const updateFcmToken = asyncHandler(async (req, res) => {
  const { fcmToken, platform } = req.body || {};
  if (!fcmToken) throw new HttpError(400, 'fcmToken is required');
  if (!(await push.registerDevice(req.user, req.schoolId, fcmToken, platform))) throw new HttpError(400, 'fcmToken is not valid');
  res.json({ success: true, message: 'Device registered for notifications' });
});

// DELETE /api/users/fcm-token { fcmToken } — signing out on this device: it stops receiving this person's notifications.
const removeFcmToken = asyncHandler(async (req, res) => {
  await push.unregisterDevice(req.user, req.schoolId, (req.body || {}).fcmToken);
  await User.updateOne({ _id: req.user._id, school: req.schoolId, fcmToken: (req.body || {}).fcmToken }, { fcmToken: null });
  res.json({ success: true, message: 'Device removed' });
});

// GET /api/users  (admin: users of own school). Optional ?page=&limit=
const getAllUsers = asyncHandler(async (req, res) => {
  const { role, search } = req.query;
  const filter = { school: req.schoolId };
  if (role && role !== 'all') filter.role = String(role);
  if (search) filter.$or = [
    { name: { $regex: escapeRegex(search), $options: 'i' } },
    { email: { $regex: escapeRegex(search), $options: 'i' } },
  ];
  const result = await paged(User, filter, pageParams(req.query),
    (q) => q.select('-password -fcmToken').populate('school', 'name').sort({ createdAt: -1 }));
  res.json({ success: true, ...result });
});

// PATCH /api/users/:id/toggle
const toggleUserStatus = asyncHandler(async (req, res) => {
  assertId(req.params.id);
  if (String(req.params.id) === String(req.user._id)) throw new HttpError(400, 'You cannot deactivate your own account');
  const user = await User.findOne({ _id: req.params.id, school: req.schoolId });
  if (!user) throw new HttpError(404, 'User not found');
  // The school must always keep one active administrator.
  if (user.isActive && user.role === ADMIN_ROLE && !(await User.exists({ school: req.schoolId, role: ADMIN_ROLE, isActive: true, _id: { $ne: user._id } }))) {
    throw new HttpError(409, 'This is the only active administrator. Make another administrator first.');
  }
  user.isActive = !user.isActive;
  await user.save();
  res.json({ success: true, data: { _id: user._id, isActive: user.isActive } });
});

module.exports = {
  loginUser, chooseSchool, registerUser, getProfile, setAvatar, removeAvatar, changePassword, resetPassword, logoutAll, forgotPassword, resetPasswordWithCode, requestLoginCode, loginWithCode, loginIdOf,
  updateFcmToken, removeFcmToken, getAllUsers, toggleUserStatus,
};
