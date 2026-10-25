// Owner console operations: overview analytics, platform accounts, announcements, support requests and platform settings.
// Reached only through routes/platformRoutes.js (platform token, role superadmin).
const School = require('../models/School');
const Student = require('../models/Student');
const User = require('../models/User');
const Invoice = require('../models/Invoice');
const SupportRequest = require('../models/SupportRequest');
const PlatformNotice = require('../models/PlatformNotice');
const PlatformSetting = require('../models/PlatformSetting');
const sub = require('../services/subscription');
const { hashPassword, validatePasswordStrength } = require('../services/credentials');
const { asyncHandler, HttpError, assertId, escapeRegex } = require('../utils/http');
const { audit } = require('../services/audit');
const pp = require('../config/platformPermissions');
const supportMail = require('../services/supportMail');

const monthKey = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
function lastMonths(n) {
  const out = []; const now = new Date();
  for (let i = n - 1; i >= 0; i -= 1) out.push(monthKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))));
  return out;
}

// ---------------- Overview ----------------

// GET /api/platform/analytics?months=6  -> real counts only; a month with nothing is a zero, not an invention.
exports.analytics = asyncHandler(async (req, res) => {
  const months = Math.min(12, Math.max(3, parseInt(req.query.months, 10) || 6));
  const keys = lastMonths(months);
  const from = new Date(`${keys[0]}-01T00:00:00.000Z`);
  const now = new Date();
  const [schools, paid, overdue, openSupport, studentsNow] = await Promise.all([
    School.find({}).select('name code createdAt subscription isActive').lean(),
    Invoice.find({ status: 'paid', paidAt: { $gte: from } }).select('total paidAt').lean(),
    Invoice.find({ status: 'issued', dueDate: { $lt: now } }).populate('school', 'name').select('number total dueDate school').sort({ dueDate: 1 }).limit(5).lean(),
    SupportRequest.countDocuments({ status: { $ne: 'resolved' } }),
    Student.countDocuments({ isActive: true }),
  ]);
  const added = Object.fromEntries(keys.map((k) => [k, 0]));
  const revenue = Object.fromEntries(keys.map((k) => [k, 0]));
  for (const s of schools) { const k = monthKey(new Date(s.createdAt)); if (k in added) added[k] += 1; }
  for (const i of paid) { const k = monthKey(new Date(i.paidAt)); if (k in revenue) revenue[k] += i.total; }
  const trialsEnding = [];
  const byState = {};
  for (const s of schools) {
    const st = sub.computeState(s, now);
    byState[st.status] = (byState[st.status] || 0) + 1;
    if (st.status === 'trial' && st.endsAt && new Date(st.endsAt) - now < 7 * 86400000) trialsEnding.push({ _id: s._id, name: s.name, endsAt: st.endsAt });
  }
  const outstanding = await Invoice.aggregate([{ $match: { status: 'issued' } }, { $group: { _id: null, total: { $sum: '$total' }, count: { $sum: 1 } } }]);
  res.json({
    success: true,
    data: {
      months: keys, schoolsAdded: keys.map((k) => added[k]), revenuePaid: keys.map((k) => revenue[k]),
      totals: { schools: schools.length, students: studentsNow, byState, outstanding: outstanding[0]?.total || 0, outstandingCount: outstanding[0]?.count || 0 },
      attention: {
        trialsEnding: trialsEnding.sort((a, b) => new Date(a.endsAt) - new Date(b.endsAt)).slice(0, 5),
        overdueInvoices: overdue, openSupportRequests: openSupport,
        readOnlySchools: byState.read_only || 0, suspendedSchools: byState.suspended || 0,
      },
    },
  });
});

// ---------------- Platform accounts ----------------

const userView = (u) => ({ _id: u._id, name: u.name, email: u.email, platformRole: pp.roleOf(u), isActive: u.isActive !== false, lastLoginAt: u.lastLoginAt || null, createdAt: u.createdAt });
const cleanRole = (r) => { if (r === undefined) return undefined; if (!pp.PLATFORM_ROLES[r]) throw new HttpError(400, 'Role must be owner, billing, support or viewer'); return r; };

exports.listRoles = asyncHandler(async (req, res) => res.json({ success: true, data: Object.entries(pp.PLATFORM_ROLES).map(([key, r]) => ({ key, label: r.label, description: r.description, permissions: r.permissions.map((p) => ({ key: p, description: pp.PLATFORM_PERMISSIONS[p] })) })) }));

exports.listUsers = asyncHandler(async (req, res) => {
  const users = await User.find({ role: 'superadmin' }).select('name email platformRole isActive lastLoginAt createdAt').sort({ createdAt: 1 }).lean();
  res.json({ success: true, data: users.map(userView), me: String(req.platformUser._id) });
});

exports.createUser = asyncHandler(async (req, res) => {
  const name = String(req.body?.name || '').trim();
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = req.body?.password;
  const platformRole = cleanRole(req.body?.platformRole) || 'viewer';
  if (name.length < 2 || name.length > 80) throw new HttpError(400, 'Enter the person\'s name');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw new HttpError(400, 'Enter a valid email address');
  const problem = validatePasswordStrength(password);
  if (problem) throw new HttpError(400, problem);
  if (await User.exists({ email }).setOptions({ crossTenant: 'login emails are unique across all schools' })) throw new HttpError(409, 'An account with this email already exists');
  const user = await User.create({ name, email, role: 'superadmin', platformRole, password: await hashPassword(password) });
  await audit(req, 'platform.user_created', { school: null, targetType: 'user', targetId: user._id, details: { email, platformRole } });
  res.status(201).json({ success: true, data: userView(user) });
});

async function otherActiveOwners(id) { return User.countDocuments({ role: 'superadmin', isActive: { $ne: false }, _id: { $ne: id }, $or: [{ platformRole: 'owner' }, { platformRole: { $exists: false } }, { platformRole: null }] }); }

// PATCH /api/platform/users/:id { isActive }
exports.updateUser = asyncHandler(async (req, res) => {
  assertId(req.params.id);
  const user = await User.findOne({ _id: req.params.id, role: 'superadmin' });
  if (!user) throw new HttpError(404, 'Account not found');
  const newRole = cleanRole(req.body?.platformRole);
  if (typeof req.body?.isActive !== 'boolean' && newRole === undefined) throw new HttpError(400, 'Nothing to change');
  if (newRole !== undefined && newRole !== pp.roleOf(user)) {
    if (String(user._id) === String(req.platformUser._id)) throw new HttpError(400, 'You cannot change your own role');
    if (pp.roleOf(user) === 'owner' && !(await otherActiveOwners(user._id))) throw new HttpError(409, 'This is the only active owner. Make another owner first.');
    user.platformRole = newRole;
    user.tokenVersion = (user.tokenVersion || 0) + 1; // the new role applies at once: the person signs in again
    await audit(req, 'platform.user_role_changed', { school: null, targetType: 'user', targetId: user._id, details: { email: user.email, platformRole: newRole } });
  }
  if (typeof req.body?.isActive === 'boolean' && req.body.isActive === false) {
    if (String(user._id) === String(req.platformUser._id)) throw new HttpError(400, 'You cannot switch off your own account');
    if (!(await otherActiveOwners(user._id))) throw new HttpError(409, 'This is the only active platform account');
  }
  if (typeof req.body?.isActive === 'boolean') user.isActive = req.body.isActive;
  if (!user.isActive) user.tokenVersion = (user.tokenVersion || 0) + 1; // signs the person out everywhere
  await user.save();
  if (typeof req.body?.isActive === 'boolean') await audit(req, user.isActive ? 'platform.user_activated' : 'platform.user_deactivated', { school: null, targetType: 'user', targetId: user._id, details: { email: user.email } });
  res.json({ success: true, data: userView(user) });
});

// POST /api/platform/users/:id/reset-password { password }  (and signs that person out everywhere)
exports.resetUserPassword = asyncHandler(async (req, res) => {
  assertId(req.params.id);
  const user = await User.findOne({ _id: req.params.id, role: 'superadmin' });
  if (!user) throw new HttpError(404, 'Account not found');
  const problem = validatePasswordStrength(req.body?.password);
  if (problem) throw new HttpError(400, problem);
  user.password = await hashPassword(req.body.password);
  user.tokenVersion = (user.tokenVersion || 0) + 1;
  await user.save();
  await audit(req, 'platform.user_password_reset', { school: null, targetType: 'user', targetId: user._id, details: { email: user.email } });
  res.json({ success: true });
});

// ---------------- Announcements ----------------

exports.listNotices = asyncHandler(async (req, res) => {
  const rows = await PlatformNotice.find({}).sort({ createdAt: -1 }).limit(100).lean();
  const now = new Date();
  res.json({ success: true, data: rows.map((n) => ({ ...n, state: n.archivedAt ? 'archived' : (n.startsAt > now ? 'scheduled' : (n.endsAt && n.endsAt < now ? 'ended' : 'live')) })) });
});

exports.createNotice = asyncHandler(async (req, res) => {
  const b = req.body || {};
  const title = String(b.title || '').trim(); const message = String(b.message || '').trim();
  if (title.length < 3) throw new HttpError(400, 'Give the announcement a title');
  if (message.length < 5) throw new HttpError(400, 'Write the message');
  if (b.level !== undefined && !['info', 'warning', 'critical'].includes(b.level)) throw new HttpError(400, 'Level must be info, warning or critical');
  const startsAt = b.startsAt ? new Date(b.startsAt) : new Date(); const endsAt = b.endsAt ? new Date(b.endsAt) : null;
  if (Number.isNaN(startsAt.getTime()) || (endsAt && Number.isNaN(endsAt.getTime()))) throw new HttpError(400, 'A date is not valid');
  if (endsAt && endsAt <= startsAt) throw new HttpError(400, 'The end must be after the start');
  const n = await PlatformNotice.create({ title, message, level: b.level || 'info', startsAt, endsAt, createdBy: req.platformUser._id });
  await audit(req, 'platform.notice_created', { school: null, targetType: 'notice', targetId: n._id, details: { title, level: n.level } });
  res.status(201).json({ success: true, data: n });
});

exports.archiveNotice = asyncHandler(async (req, res) => {
  assertId(req.params.id);
  const n = await PlatformNotice.findByIdAndUpdate(req.params.id, { archivedAt: new Date() }, { returnDocument: 'after' });
  if (!n) throw new HttpError(404, 'Announcement not found');
  await audit(req, 'platform.notice_archived', { school: null, targetType: 'notice', targetId: n._id, details: { title: n.title } });
  res.json({ success: true, data: n });
});

// ---------------- Support requests ----------------

exports.listSupport = asyncHandler(async (req, res) => {
  const filter = {};
  if (['open', 'in_progress', 'resolved'].includes(req.query.status)) filter.status = req.query.status;
  if (['low', 'normal', 'high'].includes(req.query.priority)) filter.priority = req.query.priority;
  if (req.query.search) filter.subject = { $regex: escapeRegex(String(req.query.search)), $options: 'i' };
  const page = Math.max(1, parseInt(req.query.page, 10) || 1); const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const [rows, total, counts] = await Promise.all([
    SupportRequest.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).populate('school', 'name code').populate('createdBy', 'name email').select('-notes').lean(),
    SupportRequest.countDocuments(filter),
    SupportRequest.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]),
  ]);
  res.json({ success: true, data: rows, counts: Object.fromEntries(counts.map((c) => [c._id, c.n])), pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
});

exports.getSupport = asyncHandler(async (req, res) => {
  assertId(req.params.id);
  const r = await SupportRequest.findById(req.params.id).populate('school', 'name code').populate('createdBy', 'name email').lean();
  if (!r) throw new HttpError(404, 'Request not found');
  res.json({ success: true, data: r });
});

// PATCH /api/platform/support/:id { status?, priority?, note?, internal? }
exports.updateSupport = asyncHandler(async (req, res) => {
  assertId(req.params.id);
  const r = await SupportRequest.findById(req.params.id);
  if (!r) throw new HttpError(404, 'Request not found');
  const b = req.body || {};
  const changed = [];
  if (b.status !== undefined) { if (!['open', 'in_progress', 'resolved'].includes(b.status)) throw new HttpError(400, 'Unknown status'); r.status = b.status; r.resolvedAt = b.status === 'resolved' ? new Date() : null; changed.push('status'); }
  if (b.priority !== undefined) { if (!['low', 'normal', 'high'].includes(b.priority)) throw new HttpError(400, 'Unknown priority'); r.priority = b.priority; changed.push('priority'); }
  if (typeof b.note === 'string' && b.note.trim()) { r.notes.push({ by: 'platform', author: req.platformUser.name, text: b.note.trim().slice(0, 2000), internal: b.internal === true }); changed.push(b.internal === true ? 'internal note' : 'reply'); }
  if (b.assignToMe === true) { r.assignedTo = req.platformUser._id; changed.push('assignee'); }
  if (!changed.length) throw new HttpError(400, 'Nothing to change');
  await r.save();
  await audit(req, 'platform.support_updated', { school: r.school, targetType: 'support_request', targetId: r._id, details: { changed } });
  // A public reply is also emailed to the person who opened the request (an internal note never is).
  let email = null;
  if (typeof b.note === 'string' && b.note.trim() && b.internal !== true) {
    const opener = await User.findById(r.createdBy).select('email').lean().setOptions({ crossTenant: 'the person who opened this request' });
    email = await supportMail.notifySchoolOfReply(r, opener?.email, b.note);
    r.notes[r.notes.length - 1].emailed = email.sent; await r.save();
  }
  res.json({ success: true, data: r, email });
});

// ---------------- Platform settings ----------------

const SETTINGS_DEFAULT = { orgName: 'EduAmigo', supportEmail: '', supportPhone: '', sessionHours: 12 };
async function readSettings() { const d = await PlatformSetting.findOne({ key: 'platform' }).lean(); return { ...SETTINGS_DEFAULT, ...(d?.config || {}) }; }
exports.readSettings = readSettings;

exports.getSettings = asyncHandler(async (req, res) => res.json({ success: true, data: await readSettings() }));

exports.saveSettings = asyncHandler(async (req, res) => {
  const b = req.body || {}; const cur = await readSettings(); const next = { ...cur };
  if (b.orgName !== undefined) { const v = String(b.orgName).trim(); if (v.length < 2 || v.length > 80) throw new HttpError(400, 'Organisation name must be 2 to 80 characters'); next.orgName = v; }
  if (b.supportEmail !== undefined) { const v = String(b.supportEmail).trim(); if (v && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)) throw new HttpError(400, 'Support email is not valid'); next.supportEmail = v; }
  if (b.supportPhone !== undefined) { const v = String(b.supportPhone).trim(); if (v && !/^[+\d][\d\s()-]{6,19}$/.test(v)) throw new HttpError(400, 'Support phone is not valid'); next.supportPhone = v; }
  if (b.sessionHours !== undefined) { const h = Number(b.sessionHours); if (!Number.isInteger(h) || h < 1 || h > 24) throw new HttpError(400, 'Session length must be 1 to 24 hours'); next.sessionHours = h; }
  await PlatformSetting.updateOne({ key: 'platform' }, { $set: { config: next, updatedBy: req.platformUser._id } }, { upsert: true });
  await audit(req, 'platform.settings_saved', { school: null, targetType: 'settings', targetId: 'platform', details: { fields: Object.keys(b) } });
  res.json({ success: true, data: next });
});
