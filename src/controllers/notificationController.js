const Notification = require('../models/Notification');
const Student = require('../models/Student');
const Parent = require('../models/Parent');

const sendNotification = async (req, res) => {
  try {
    const { title, message, targetRole, targetId, type } = req.body;
    if (!title || !message) {
      return res.status(400).json({ success: false, message: 'Title and message are required' });
    }
    const notification = await Notification.create({
      title, message, targetRole: targetRole || 'all', targetId, type: type || 'General'
    });
    res.status(201).json({ success: true, message: 'Notification sent successfully!', data: notification });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

const getAllNotifications = async (req, res) => {
  try {
    const { targetRole, targetId } = req.query;
    const filter = {};
    if (targetRole) filter.targetRole = { $in: [targetRole, 'all'] };
    if (targetId) filter.targetId = targetId;
    const notifications = await Notification.find(filter).sort({ createdAt: -1 });
    res.status(200).json({ success: true, count: notifications.length, data: notifications });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

const getMyNotifications = async (req, res) => {
  try {
    const role = req.user.role; // 'student' | 'parent'
    let targetId = null;

    if (role === 'student') {
      const student = await Student.findOne({ userId: req.user._id });
      targetId = student?._id;
    } else if (role === 'parent') {
      const parent = await Parent.findOne({ userId: req.user._id });
      targetId = parent?._id;
    }

    const notifications = await Notification.find({
      $or: [
        { targetRole: 'all' },
        { targetRole: role },
        { targetId: targetId }
      ]
    }).sort({ createdAt: -1 }).limit(20);

    res.status(200).json({ success: true, data: notifications });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

const deleteNotification = async (req, res) => {
  try {
    await Notification.findByIdAndDelete(req.params.id);
    res.status(200).json({ success: true, message: 'Notification deleted successfully!' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

module.exports = { sendNotification, getAllNotifications, getMyNotifications, deleteNotification };