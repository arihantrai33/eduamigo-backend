const Message = require('../models/Message');
const Broadcast = require('../models/Broadcast');
const Teacher = require('../models/Teacher');
const Student = require('../models/Student');
const User = require('../models/User');

// GET /api/chat/teachers — student ke class ke teachers
const getMyTeachers = async (req, res) => {
  try {
    const student = await Student.findOne({ userId: req.user._id });
    if (!student) return res.status(404).json({ success: false, message: 'Student not found' });

    const teachers = await Teacher.find({
      school: req.user.school,
      isActive: true,
    }).populate('userId', 'name email');

    const teacherList = teachers.map(t => ({
      _id: t._id,
      userId: t.userId?._id,
      name: t.userId?.name || t.name,
      subject: t.subject,
      roomId: [req.user._id, t.userId?._id].sort().join('_'),
    }));

    res.json({ success: true, data: teacherList });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

// GET /api/chat/messages/:roomId — messages fetch
const getMessages = async (req, res) => {
  try {
    const messages = await Message.find({ roomId: req.params.roomId })
      .sort({ createdAt: 1 });
    // Mark as read
    await Message.updateMany(
      { roomId: req.params.roomId, receiverId: req.user._id, read: false },
      { read: true }
    );
    res.json({ success: true, data: messages });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

// POST /api/chat/messages — message send
const sendMessage = async (req, res) => {
  try {
    const { receiverId, text, roomId } = req.body;
    if (!receiverId || !text || !roomId)
      return res.status(400).json({ success: false, message: 'receiverId, text, roomId required' });

    const message = await Message.create({
      senderId: req.user._id,
      receiverId,
      roomId,
      text,
      school: req.user.school,
    });
    res.status(201).json({ success: true, data: message });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

// GET /api/chat/broadcasts — class broadcasts
const getBroadcasts = async (req, res) => {
  try {
    const student = await Student.findOne({ userId: req.user._id });
    if (!student) return res.status(404).json({ success: false, message: 'Student not found' });

    const broadcasts = await Broadcast.find({
      school: req.user.school,
      class: student.class,
      $or: [{ section: student.section }, { section: null }, { section: '' }],
    }).sort({ createdAt: -1 }).limit(20);

    res.json({ success: true, data: broadcasts });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

// GET /api/chat/admin — admin contact
const getAdminContact = async (req, res) => {
  try {
    const admin = await User.findOne({ school: req.user.school, role: 'admin' })
      .select('name email');
    res.json({ success: true, data: { 
      name: admin?.name || 'School Administration',
      userId: admin?._id,
      roomId: [req.user._id, admin?._id].sort().join('_'),
    }});
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

module.exports = { getMyTeachers, getMessages, sendMessage, getBroadcasts, getAdminContact };
