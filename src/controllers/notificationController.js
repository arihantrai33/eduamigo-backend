const Notification = require('../models/Notification');

const sendNotification = async (req, res) => {
  try {
    const { title, message, type, targetRole, targetClass, targetSection } = req.body;
    if (!title || !message) return res.status(400).json({ success: false, message: 'Title and message required' });
    const notification = new Notification({ title, message, type: type || 'General', targetRole: targetRole || 'all', targetClass: targetClass || null, targetSection: targetSection || null, createdBy: req.user._id });
    await notification.save();
    const io = req.app.get('io');
    if (io) {
      const room = notification.targetRole === 'all' ? 'all' : notification.targetRole;
      io.to(room).emit('new_notification', notification);
      if (room !== 'all') io.to('all').emit('new_notification', notification);
    }
    res.status(201).json({ success: true, message: 'Notification sent', data: notification });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

const getAllNotifications = async (req, res) => {
  try {
    const notifs = await Notification.find().sort({ createdAt: -1 });
    res.json({ success: true, data: notifs });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

const getMyNotifications = async (req, res) => {
  try {
    const role = req.user.role;
    const notifs = await Notification.find({ $or: [{ targetRole: 'all' }, { targetRole: role }] }).sort({ createdAt: -1 });
    res.json({ success: true, data: notifs });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

const deleteNotification = async (req, res) => {
  try {
    await Notification.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: 'Deleted' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

module.exports = { sendNotification, getAllNotifications, getMyNotifications, deleteNotification };
