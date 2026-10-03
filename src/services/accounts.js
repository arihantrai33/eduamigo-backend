// Sign-in identity and self-service password reset.
//
// Sign-in IDs, always together with the school code except for email:
//   staff    -> email (or mobile)
//   student  -> admission number
//   parent   -> mobile number (or email)
// Email alone still works without a school code because emails are unique across the platform.

const crypto = require('crypto');
const User = require('../models/User');
const Student = require('../models/Student');
const School = require('../models/School');
const PasswordReset = require('../models/PasswordReset');
const { normalizePhone } = require('../utils/phone');
const { jwtSecret } = require('../config/env');
const { hashPassword } = require('./credentials');
const email = require('./email');

const SCHOOL_FIELDS = 'name code isActive branding subscription';
const PHONE_LOGIN_ROLES = ['parent', 'teacher', 'admin', 'accountant'];
const RESET_CODE_MINUTES = 15;
const RESET_MAX_ATTEMPTS = 5;
const RESET_RESEND_SECONDS = 60;

// Accounts that a sign-in ID could refer to (usually one). The password decides which one it is.
async function loginCandidates({ email: emailInput, schoolCode, identifier } = {}) {
  const id = String(identifier ?? emailInput ?? '').trim();
  if (!id || id.length > 120) return [];

  if (id.includes('@')) {
    const filter = { email: id.toLowerCase(), role: { $ne: 'superadmin' } };
    if (schoolCode) {
      const school = await School.findOne({ code: String(schoolCode).trim().toUpperCase() }).select('_id');
      if (!school) return [];
      filter.school = school._id;
    }
    return User.find(filter).limit(1).populate('school', SCHOOL_FIELDS);
  }

  if (!schoolCode) return [];
  const school = await School.findOne({ code: String(schoolCode).trim().toUpperCase() }).select('_id');
  if (!school) return [];

  const ids = [];
  const student = await Student.findOne({ school: school._id, admissionNo: id }).select('userId');
  if (student?.userId) ids.push(student.userId);
  const phone = normalizePhone(id);
  if (phone.length === 10) {
    const byPhone = await User.find({ school: school._id, loginPhone: phone, role: { $in: PHONE_LOGIN_ROLES } }).select('_id').limit(5);
    ids.push(...byPhone.map((u) => u._id));
  }
  if (!ids.length) return [];
  return User.find({ _id: { $in: ids }, school: school._id }).populate('school', SCHOOL_FIELDS);
}

// The candidate whose password matches, or null.
async function authenticate(credentials, password) {
  const candidates = await loginCandidates(credentials);
  for (const user of candidates) {
    if (await user.comparePassword(password)) return user;
  }
  return null;
}

// ---------------- Password reset by email code ----------------

const hashCode = (userId, code) => crypto.createHmac('sha256', jwtSecret()).update(`${userId}:${code}`).digest('hex');

function resetEmailText(user, code) {
  const school = user.school?.branding?.appName || user.school?.name || 'EduAmigo';
  return [
    `Hello ${user.name},`,
    '',
    `Your ${school} password reset code is: ${code}`,
    '',
    `It expires in ${RESET_CODE_MINUTES} minutes. If you did not ask to reset your password, you can ignore this email;`,
    'your password has not changed.',
    '',
    '- EduAmigo',
  ].join('\n');
}

// Sends a reset code to every matching active account that has an email. Never reveals whether
// an account exists: the caller always answers the same way.
async function requestPasswordReset(credentials) {
  const candidates = await loginCandidates(credentials);
  let sent = 0;
  for (const user of candidates) {
    if (!user.email || !user.isActive || !user.school || user.school.isActive === false) continue;
    const recent = await PasswordReset.findOne({ user: user._id, createdAt: { $gt: new Date(Date.now() - RESET_RESEND_SECONDS * 1000) } });
    if (recent) continue;
    const code = String(crypto.randomInt(100000, 1000000));
    await PasswordReset.deleteMany({ user: user._id });
    await PasswordReset.create({ user: user._id, codeHash: hashCode(user._id, code), expiresAt: new Date(Date.now() + RESET_CODE_MINUTES * 60000) });
    try {
      await email.sendEmail({ to: user.email, subject: 'Your password reset code', text: resetEmailText(user, code) });
      sent += 1;
    } catch (err) {
      console.error(`Password reset email to user ${user._id} failed:`, err.message);
    }
  }
  return sent;
}

// Checks the code and sets the new password. Signs the user out of every device.
async function resetPasswordWithCode(credentials, code, newPassword) {
  const candidates = await loginCandidates(credentials);
  const cleanCode = String(code || '').trim();
  for (const user of candidates) {
    const reset = await PasswordReset.findOne({ user: user._id, expiresAt: { $gt: new Date() } });
    if (!reset) continue;
    reset.attempts += 1;
    if (reset.attempts > RESET_MAX_ATTEMPTS) {
      await reset.deleteOne();
      continue;
    }
    await reset.save();
    const expected = Buffer.from(reset.codeHash, 'hex');
    const given = Buffer.from(hashCode(user._id, cleanCode), 'hex');
    if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) continue;

    await User.updateOne({ _id: user._id }, {
      $set: { password: await hashPassword(newPassword), mustChangePassword: false, passwordChangedAt: new Date() },
      $inc: { tokenVersion: 1 },
    });
    await PasswordReset.deleteMany({ user: user._id });
    return true;
  }
  return false;
}

module.exports = { loginCandidates, authenticate, requestPasswordReset, resetPasswordWithCode, PHONE_LOGIN_ROLES };
