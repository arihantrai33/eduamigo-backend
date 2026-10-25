// School side of platform communication: announcements from EduAmigo (read) and support requests to EduAmigo (create, read own,
// reply). Every request is scoped to the signed-in school; internal notes written by the owner are never returned.
const express = require('express');
const router = express.Router();
const PlatformNotice = require('../models/PlatformNotice');
const SupportRequest = require('../models/SupportRequest');
const { protect, requirePermission, authorizeRoles } = require('../middleware/authMiddleware');
const { asyncHandler, HttpError, assertId } = require('../utils/http');
const { audit } = require('../services/audit');
const supportMail = require('../services/supportMail');
const { readSettings } = require('../controllers/platformOpsController');
const School = require('../models/School');

router.use(protect);

// Email EduAmigo's support address (Settings in the console) when a school writes. Fire and forget: failure never changes the answer.
async function tellSupport(req, r, text) {
  try {
    const to = (await readSettings()).supportEmail;
    if (!to) return;
    const school = await School.findById(req.schoolId).select('name').lean();
    await supportMail.notifySupportOfMessage(r, school?.name || 'A school', to, text);
  } catch { /* best effort */ }
}
const CATEGORIES = ['billing', 'technical', 'account', 'feature', 'other'];
const publicView = (r) => ({
  _id: r._id, subject: r.subject, category: r.category, priority: r.priority, status: r.status, createdAt: r.createdAt, resolvedAt: r.resolvedAt,
  messages: (r.notes || []).filter((n) => !n.internal).map((n) => ({ by: n.by, author: n.by === 'platform' ? 'EduAmigo support' : n.author, text: n.text, at: n.at })),
});

// GET /api/support/notices: announcements that are live now (office roles only)
router.get('/notices', authorizeRoles('admin', 'accountant', 'staff'), asyncHandler(async (req, res) => {
  const now = new Date();
  const rows = await PlatformNotice.find({ archivedAt: null, startsAt: { $lte: now }, $or: [{ endsAt: null }, { endsAt: { $gt: now } }] }).sort({ startsAt: -1 }).limit(5).select('title message level startsAt').lean();
  res.json({ success: true, data: rows });
}));

router.get('/requests', requirePermission('settings.manage'), asyncHandler(async (req, res) => {
  const rows = await SupportRequest.find({ school: req.schoolId }).sort({ createdAt: -1 }).limit(50).lean();
  res.json({ success: true, data: rows.map(publicView) });
}));

router.post('/requests', requirePermission('settings.manage'), asyncHandler(async (req, res) => {
  const b = req.body || {};
  const subject = String(b.subject || '').trim(); const message = String(b.message || '').trim();
  if (subject.length < 4 || subject.length > 140) throw new HttpError(400, 'Write a short subject (4 to 140 characters)');
  if (message.length < 10) throw new HttpError(400, 'Describe what you need (at least 10 characters)');
  const category = CATEGORIES.includes(b.category) ? b.category : 'other';
  const open = await SupportRequest.countDocuments({ school: req.schoolId, status: { $ne: 'resolved' } });
  if (open >= 20) throw new HttpError(429, 'You already have 20 open requests. Please wait for replies.');
  const r = await SupportRequest.create({ school: req.schoolId, createdBy: req.user._id, subject, category, notes: [{ by: 'school', author: req.user.name, text: message.slice(0, 2000) }] });
  await audit(req, 'support_request.created', { targetType: 'support_request', targetId: r._id, details: { category } });
  tellSupport(req, r, message);
  res.status(201).json({ success: true, data: publicView(r) });
}));

router.post('/requests/:id/reply', requirePermission('settings.manage'), asyncHandler(async (req, res) => {
  assertId(req.params.id);
  const text = String(req.body?.message || '').trim();
  if (text.length < 2) throw new HttpError(400, 'Write your message');
  const r = await SupportRequest.findOne({ _id: req.params.id, school: req.schoolId });
  if (!r) throw new HttpError(404, 'Request not found');
  r.notes.push({ by: 'school', author: req.user.name, text: text.slice(0, 2000) });
  if (r.status === 'resolved') { r.status = 'open'; r.resolvedAt = null; }
  await r.save();
  tellSupport(req, r, text);
  res.json({ success: true, data: publicView(r) });
}));

module.exports = router;
