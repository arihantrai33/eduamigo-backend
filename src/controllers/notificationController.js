const Notification = require('../models/Notification');
const { HttpError, asyncHandler, assertId } = require('../utils/http');
const { broadcast } = require('../services/notify');

const ROLES = ['all', 'student', 'teacher', 'parent', 'admin'];

// POST /api/notifications/send (admin) — broadcast to a role within the school
const sendNotification = asyncHandler(async (req, res) => {
  const { title, message, type, targetRole } = req.body || {};
  if (!title || !message) throw new HttpError(400, 'Title and message are required');
  const role = targetRole || 'all';
  if (!ROLES.includes(role)) throw new HttpError(400, 'Invalid target role');
  const notification = await broadcast(req.schoolId, {
    title, message, targetRole: role, createdBy: req.user._id,
    type: ['General', 'Info', 'Fee', 'Exam', 'Attendance', 'Leave', 'Transport', 'Event'].includes(type) ? type : 'General',
  });
  res.status(201).json({ success: true, message: 'Notification sent', data: notification });
});

// GET /api/notifications (admin) — broadcasts sent in this school
const getAllNotifications = asyncHandler(async (req, res) => {
  const notifs = await Notification.find({ school: req.schoolId, recipient: null }).sort({ createdAt: -1 }).limit(500);
  res.json({ success: true, data: notifs });
});

// GET /api/notifications/my — personal notifications + broadcasts for my role, in my school only
const getMyNotifications = asyncHandler(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 200);
  const notifs = await Notification.find({
    school: req.schoolId,
    $or: [
      { recipient: req.user._id },
      { recipient: null, targetRole: { $in: ['all', req.user.role] } },
    ],
  }).sort({ createdAt: -1 }).limit(limit).lean();
  const me = String(req.user._id);
  const data = notifs.map(({ readBy = [], ...n }) => ({ ...n, read: readBy.some((id) => String(id) === me) }));
  res.json({ success: true, unread: data.filter((n) => !n.read).length, data });
});

// PATCH /api/notifications/read  { ids?: [] } — mark some or all as read
const markRead = asyncHandler(async (req, res) => {
  const filter = {
    school: req.schoolId,
    $or: [{ recipient: req.user._id }, { recipient: null, targetRole: { $in: ['all', req.user.role] } }],
  };
  if (Array.isArray(req.body?.ids) && req.body.ids.length) {
    req.body.ids.forEach((id) => assertId(id));
    filter._id = { $in: req.body.ids };
  }
  const result = await Notification.updateMany(filter, { $addToSet: { readBy: req.user._id } });
  res.json({ success: true, updated: result.modifiedCount });
});

// DELETE /api/notifications/:id (admin)
const deleteNotification = asyncHandler(async (req, res) => {
  assertId(req.params.id);
  const deleted = await Notification.findOneAndDelete({ _id: req.params.id, school: req.schoolId });
  if (!deleted) throw new HttpError(404, 'Notification not found');
  res.json({ success: true, message: 'Deleted' });
});

module.exports = { sendNotification, getAllNotifications, getMyNotifications, markRead, deleteNotification };
