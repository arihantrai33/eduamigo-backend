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

const SCHOOL_FIELDS = 'name code city isActive branding subscription';
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

// A mobile number typed without a school. The same number can belong to accounts in several schools (a parent with children
// in two of them), so every account with this number whose password matches is returned (at most six are tried). Nothing about
// accounts whose password does not match is revealed.
async function authenticateByPhoneAcrossSchools(phone, password) {
  const candidates = await User.find({ loginPhone: phone, role: { $in: PHONE_LOGIN_ROLES } }).limit(6).populate('school', SCHOOL_FIELDS);
  const matched = [];
  for (const user of candidates) {
    if (await user.comparePassword(password)) matched.push(user);
  }
  return matched;
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

// ---------------- One-time codes: password reset and sign-in without a password ----------------
// A code goes to the mobile number when the person typed a mobile number, otherwise to the email, and to the other one when the
// first is not on file. The caller always answers the same way, whether or not an account exists.

const LOGIN_CODE_MINUTES = 10;
const CODES_PER_HOUR = 6;
const smsService = require('./sms');
const { maskPhone } = require('./integrations');

const ofPurpose = (purpose) => (purpose === 'reset' ? { $or: [{ purpose: 'reset' }, { purpose: { $exists: false } }] } : { purpose });

// The mobile number is tried first only when SMS really goes out (live provider); with SMS in test mode it is the last resort.
function channelsFor(user, id, smsLive) {
  const typedPhone = smsLive && !id.includes('@') && normalizePhone(id).length === 10;
  const hasSms = !!(user.phone && normalizePhone(user.phone).length === 10);
  const order = typedPhone ? ['sms', 'email'] : ['email', 'sms'];
  return order.filter((c) => (c === 'sms' ? hasSms : !!user.email));
}

function codeText(user, code, purpose) {
  const school = user.school?.branding?.appName || user.school?.name || 'EduAmigo';
  const what = purpose === 'login' ? 'sign-in code' : 'password reset code';
  const minutes = purpose === 'login' ? LOGIN_CODE_MINUTES : RESET_CODE_MINUTES;
  return [
    `Hello ${user.name},`, '',
    `Your ${school} ${what} is: ${code}`, '',
    `It expires in ${minutes} minutes. Do not share it with anyone. If you did not ask for it, you can ignore this message.`, '',
    '- EduAmigo',
  ].join('\n');
}

async function deliver(user, channel, code, purpose) {
  if (channel === 'email') {
    await email.sendEmail({ to: user.email, subject: purpose === 'login' ? 'Your sign-in code' : 'Your password reset code', text: codeText(user, code, purpose) });
    return;
  }
  const phone = smsService.normalizePhone(user.phone);
  const sent = await smsService.sendCode(await smsService.loadSms(), phone, code, undefined, { live: true });
  // Local demo only: with the SMS provider in test mode nothing leaves the machine, so the code is shown in this server's console.
  if (sent.simulated && process.env.NODE_ENV !== 'production') console.log(`[one-time code] ${purpose} for ${maskPhone(phone)}: ${code}`);
}

// Sends a code to every matching active account. Returns how many were sent.
async function requestCode(credentials, purpose = 'reset') {
  const id = String(credentials.identifier ?? credentials.email ?? '').trim();
  const candidates = await loginCandidates(credentials);
  const minutes = purpose === 'login' ? LOGIN_CODE_MINUTES : RESET_CODE_MINUTES;
  let sent = 0;
  const smsDoc = candidates.length ? await smsService.loadSms() : null;
  const smsLive = !!smsDoc && smsService.goesLive(smsDoc.config, smsDoc.enabled, true);
  for (const user of candidates) {
    if (!user.isActive || !user.school || user.school.isActive === false) continue;
    const channels = channelsFor(user, id, smsLive);
    if (!channels.length) continue;
    const now = Date.now();
    if (await PasswordReset.findOne({ user: user._id, ...ofPurpose(purpose), createdAt: { $gt: new Date(now - RESET_RESEND_SECONDS * 1000) } })) continue;
    if (await PasswordReset.countDocuments({ user: user._id, createdAt: { $gt: new Date(now - 3600 * 1000) } }) >= CODES_PER_HOUR) continue;
    const code = String(crypto.randomInt(100000, 1000000));
    await PasswordReset.deleteMany({ user: user._id, ...ofPurpose(purpose) });
    const row = await PasswordReset.create({ user: user._id, purpose, channel: channels[0], codeHash: hashCode(user._id, code), expiresAt: new Date(now + minutes * 60000) });
    for (const channel of channels) {
      try {
        await deliver(user, channel, code, purpose);
        if (channel !== row.channel) await PasswordReset.updateOne({ _id: row._id }, { $set: { channel } });
        sent += 1;
        break;
      } catch (err) {
        console.error(`One-time code (${purpose}) by ${channel} to user ${user._id} failed:`, err.message);
      }
    }
  }
  return sent;
}

// The account whose code matches, or null. Every wrong guess counts; after five the code is gone.
async function checkCode(credentials, code, purpose) {
  const candidates = await loginCandidates(credentials);
  const cleanCode = String(code || '').trim();
  for (const user of candidates) {
    const reset = await PasswordReset.findOne({ user: user._id, ...ofPurpose(purpose), expiresAt: { $gt: new Date() } });
    if (!reset) continue;
    reset.attempts += 1;
    if (reset.attempts > RESET_MAX_ATTEMPTS) { await reset.deleteOne(); continue; }
    await reset.save();
    const expected = Buffer.from(reset.codeHash, 'hex');
    const given = Buffer.from(hashCode(user._id, cleanCode), 'hex');
    if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) continue;
    await PasswordReset.deleteMany({ user: user._id, ...ofPurpose(purpose) });
    return user;
  }
  return null;
}

const requestPasswordReset = (credentials) => requestCode(credentials, 'reset');
const requestLoginCode = (credentials) => requestCode(credentials, 'login');
const loginWithCode = (credentials, code) => checkCode(credentials, code, 'login');

// Checks the code and sets the new password. Signs the user out of every device.
async function resetPasswordWithCode(credentials, code, newPassword) {
  const user = await checkCode(credentials, code, 'reset');
  if (!user) return false;
  await User.updateOne({ _id: user._id }, {
    $set: { password: await hashPassword(newPassword), mustChangePassword: false, passwordChangedAt: new Date() },
    $inc: { tokenVersion: 1 },
  });
  return true;
}

module.exports = { loginCandidates, authenticate, authenticateByPhoneAcrossSchools, requestPasswordReset, requestLoginCode, loginWithCode, resetPasswordWithCode, PHONE_LOGIN_ROLES };
