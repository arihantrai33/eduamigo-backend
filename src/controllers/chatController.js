const Message   = require('../models/Message');
const Broadcast = require('../models/Broadcast');
const Teacher   = require('../models/Teacher');
const Student   = require('../models/Student');
const Parent    = require('../models/Parent');
const Timetable = require('../models/Timetable');
const User      = require('../models/User');

// GET /api/chat/teachers
const getMyTeachers = async (req, res) => {
  try {
    const student = await Student.findOne({ userId: req.user._id });
    if (!student) return res.status(404).json({ success: false, message: 'Student not found' });

    const teachers = await Teacher.find({ school: req.user.school, isActive: true })
      .populate('userId', 'name email');

    const teacherList = teachers.map(t => ({
      _id:     t._id,
      userId:  t.userId?._id,
      name:    t.userId?.name || t.name,
      subject: t.subject,
      roomId:  [req.user._id, t.userId?._id].sort().join('_'),
    }));

    res.json({ success: true, data: teacherList });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

// GET /api/chat/parent-teachers
const getParentTeachers = async (req, res) => {
  try {
    const parent = await Parent.findOne({ userId: req.user._id })
      .populate('children', 'name class section');
    if (!parent || !parent.children?.length)
      return res.status(404).json({ success: false, message: 'No child linked' });

    const child = parent.children[0];

    const timetables = await Timetable.find({
      class:   child.class,
      section: child.section,
    }).populate({
      path:   'periods.teacher',
      select: 'name subject userId',
      populate: { path: 'userId', select: 'name' },
    });

    const seen = new Set();
    const teacherList = [];

    for (const tt of timetables) {
      for (const period of tt.periods) {
        const t = period.teacher;
        if (!t || !t.userId) continue;
        const key = t._id.toString();
        if (seen.has(key)) continue;
        seen.add(key);
        teacherList.push({
          _id:     t._id,
          userId:  t.userId._id,
          name:    t.userId.name || t.name,
          subject: period.subject || t.subject,
          roomId:  [req.user._id, t.userId._id].sort().join('_'),
        });
      }
    }

    const admin = await User.findOne({ school: req.user.school, role: 'admin' }).select('name _id');

    res.json({
      success: true,
      data: {
        child:    { name: child.name, class: child.class, section: child.section },
        teachers: teacherList,
        admin: admin ? {
          name:   admin.name || 'School Administration',
          userId: admin._id,
          roomId: [req.user._id, admin._id].sort().join('_'),
        } : null,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

// GET /api/chat/messages/:roomId
const getMessages = async (req, res) => {
  try {
    const messages = await Message.find({ roomId: req.params.roomId }).sort({ createdAt: 1 });
    await Message.updateMany(
      { roomId: req.params.roomId, receiverId: req.user._id, read: false },
      { read: true }
    );
    res.json({ success: true, data: messages });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

// POST /api/chat/messages
const sendMessage = async (req, res) => {
  try {
    const { receiverId, text, roomId } = req.body;
    if (!receiverId || !text || !roomId)
      return res.status(400).json({ success: false, message: 'receiverId, text, roomId required' });

    const message = await Message.create({
      senderId:   req.user._id,
      receiverId,
      roomId,
      text,
      school:     req.user.school,
    });
    res.status(201).json({ success: true, data: message });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

// GET /api/chat/broadcasts
const getBroadcasts = async (req, res) => {
  try {
    const student = await Student.findOne({ userId: req.user._id });
    if (!student) return res.status(404).json({ success: false, message: 'Student not found' });

    const broadcasts = await Broadcast.find({
      school: req.user.school,
      class:  student.class,
      $or: [{ section: student.section }, { section: null }, { section: '' }],
    }).sort({ createdAt: -1 }).limit(20);

    res.json({ success: true, data: broadcasts });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

// GET /api/chat/admin
const getAdminContact = async (req, res) => {
  try {
    const admin = await User.findOne({ school: req.user.school, role: 'admin' }).select('name email');
    res.json({ success: true, data: {
      name:   admin?.name || 'School Administration',
      userId: admin?._id,
      roomId: [req.user._id, admin?._id].sort().join('_'),
    }});
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

// GET /api/chat/unread-count
const getUnreadCount = async (req, res) => {
  try {
    const count = await Message.countDocuments({
      receiverId: req.user._id,
      read: false,
    });
    res.json({ success: true, count });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

module.exports = {
  getMyTeachers,
  getParentTeachers,
  getMessages,
  sendMessage,
  getBroadcasts,
  getAdminContact,
  getUnreadCount,
};