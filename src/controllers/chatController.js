const Conversation = require('../models/Conversation');
const mongoose = require('mongoose');
const Message = require('../models/Message');
const Broadcast = require('../models/Broadcast');
const Teacher = require('../models/Teacher');
const Student = require('../models/Student');
const Parent = require('../models/Parent');
const Timetable = require('../models/Timetable');
const User = require('../models/User');
const { HttpError, asyncHandler, assertId } = require('../utils/http');
const { parseClassKey } = require('../utils/classes');
const { studentForUser, teacherForUser, resolveChild } = require('../services/directory');

const roomFor = (a, b) => [String(a), String(b)].sort().join('_');

// Who may talk to whom inside a school. Students and parents cannot message each other directly.
const ALLOWED = {
  admin: ['admin', 'accountant', 'teacher', 'student', 'parent'],
  accountant: ['admin', 'accountant', 'parent'],
  teacher: ['admin', 'teacher', 'student', 'parent'],
  student: ['admin', 'teacher'],
  parent: ['admin', 'accountant', 'teacher'],
};

// Unread count + last message for many rooms in two queries (instead of 2 per contact).
async function roomStats(school, userId, roomIds) {
  if (!roomIds.length) return new Map();
  const me = new mongoose.Types.ObjectId(String(userId));
  const [unread, last] = await Promise.all([
    Message.aggregate([
      { $match: { school: new mongoose.Types.ObjectId(String(school)), roomId: { $in: roomIds }, receiverId: me, read: false } },
      { $group: { _id: '$roomId', n: { $sum: 1 } } },
    ]),
    Conversation.find({ school, roomId: { $in: roomIds } }).select('roomId lastText lastAt').lean(),
  ]);
  const stats = new Map(roomIds.map((r) => [r, { unread: 0, lastMsg: '', lastTime: null }]));
  unread.forEach((u) => { stats.get(u._id).unread = u.n; });
  last.forEach((c) => Object.assign(stats.get(c.roomId), { lastMsg: c.lastText, lastTime: c.lastAt }));
  return stats;
}

// GET /api/chat/teachers (student) — teachers who teach the student's class
const getMyTeachers = asyncHandler(async (req, res) => {
  const student = await studentForUser(req.user);
  if (!student) throw new HttpError(404, 'Student not found');
  const teachers = await teachersForClass(req.schoolId, student.class, student.section);
  res.json({
    success: true,
    data: teachers.map((t) => ({ _id: t._id, userId: t.userId, name: t.name, subject: t.subject, roomId: roomFor(req.user._id, t.userId) })),
  });
});

// Teachers linked to a class through the timetable or assignedClasses.
async function teachersForClass(school, cls, section) {
  const timetables = await Timetable.find({ school, class: cls, section }).populate('periods.teacher', 'name subjects userId isActive');
  const map = new Map();
  for (const tt of timetables) {
    for (const p of tt.periods) {
      const t = p.teacher;
      if (t && t.userId && t.isActive !== false && !map.has(String(t._id))) {
        map.set(String(t._id), { _id: t._id, userId: t.userId, name: t.name, subject: p.subject || t.subjects?.[0] || '' });
      }
    }
  }
  const assigned = await Teacher.find({ school, isActive: true, userId: { $ne: null }, assignedClasses: { $in: [`${cls}-${section}`, cls] } });
  for (const t of assigned) {
    if (!map.has(String(t._id))) map.set(String(t._id), { _id: t._id, userId: t.userId, name: t.name, subject: t.subjects?.[0] || '' });
  }
  return [...map.values()];
}

// GET /api/chat/parent-teachers?studentId= (parent)
const getParentTeachers = asyncHandler(async (req, res) => {
  const { child } = await resolveChild(req.user, req.query.studentId);
  if (!child) throw new HttpError(404, 'No child is linked to this account');
  const teachers = await teachersForClass(req.schoolId, child.class, child.section);
  const admin = await User.findOne({ school: req.schoolId, role: 'admin', isActive: true }).select('name');
  res.json({
    success: true,
    data: {
      child: { _id: child._id, name: child.name, class: child.class, section: child.section },
      teachers: teachers.map((t) => ({ ...t, roomId: roomFor(req.user._id, t.userId) })),
      admin: admin ? { name: admin.name || 'School Administration', userId: admin._id, roomId: roomFor(req.user._id, admin._id) } : null,
    },
  });
});

// GET /api/chat/messages/:roomId — only participants can read a room
const getMessages = asyncHandler(async (req, res) => {
  const { roomId } = req.params;
  const parts = String(roomId).split('_');
  if (parts.length !== 2 || !parts.includes(String(req.user._id))) throw new HttpError(403, 'You are not part of this conversation');
  const filter = { roomId, school: req.schoolId };
  if (req.query.after) {
    const after = new Date(req.query.after);
    if (!Number.isNaN(after.getTime())) filter.createdAt = { $gt: after };
  }
  const messages = await Message.find(filter).sort({ createdAt: 1 }).limit(500);
  await Message.updateMany({ roomId, school: req.schoolId, receiverId: req.user._id, read: false }, { read: true });
  res.json({ success: true, data: messages });
});

// POST /api/chat/messages  { receiverId, text?, fileUrl?, fileName?, fileType? }
const sendMessage = asyncHandler(async (req, res) => {
  const { receiverId, fileUrl, fileName, fileType } = req.body || {};
  const text = String(req.body?.text || '').trim();
  assertId(receiverId, 'receiverId');
  if (!text && !fileUrl) throw new HttpError(400, 'Message text or a file is required');
  if (text.length > 4000) throw new HttpError(400, 'Message is too long');
  if (fileUrl && !/^https:\/\//i.test(fileUrl)) throw new HttpError(400, 'Invalid file link');
  if (String(receiverId) === String(req.user._id)) throw new HttpError(400, 'You cannot message yourself');

  const receiver = await User.findOne({ _id: receiverId, school: req.schoolId, isActive: true }).select('role');
  if (!receiver) throw new HttpError(404, 'Recipient not found');
  if (!(ALLOWED[req.user.role] || []).includes(receiver.role)) throw new HttpError(403, 'You cannot message this user');

  const message = await Message.create({
    senderId: req.user._id, receiverId, roomId: roomFor(req.user._id, receiverId),
    text, fileUrl: fileUrl || null, fileName: fileName || null, fileType: fileType || null, school: req.schoolId,
  });
  await Conversation.updateOne(
    { school: req.schoolId, roomId: message.roomId },
    {
      $set: { school: req.schoolId, participants: [req.user._id, receiver._id], lastText: text || `Attachment: ${fileName || 'file'}`, lastAt: message.createdAt, lastSender: req.user._id },
    },
    { upsert: true },
  );
  res.status(201).json({ success: true, data: message });
});

// GET /api/chat/broadcasts (student)
const getBroadcasts = asyncHandler(async (req, res) => {
  const student = await studentForUser(req.user);
  if (!student) throw new HttpError(404, 'Student not found');
  const broadcasts = await Broadcast.find({
    school: req.schoolId, class: student.class,
    $or: [{ section: student.section }, { section: null }, { section: '' }],
  }).sort({ createdAt: -1 }).limit(20);
  res.json({ success: true, data: broadcasts });
});

// GET /api/chat/admin
const getAdminContact = asyncHandler(async (req, res) => {
  const admin = await User.findOne({ school: req.schoolId, role: 'admin', isActive: true }).select('name');
  if (!admin) throw new HttpError(404, 'No school administrator is available');
  res.json({ success: true, data: { name: admin.name || 'School Administration', userId: admin._id, roomId: roomFor(req.user._id, admin._id) } });
});

// GET /api/chat/unread-count
const getUnreadCount = asyncHandler(async (req, res) => {
  const count = await Message.countDocuments({ school: req.schoolId, receiverId: req.user._id, read: false });
  res.json({ success: true, count });
});

// GET /api/chat/teacher-contacts (teacher) — students and parents of assigned classes
const getTeacherContacts = asyncHandler(async (req, res) => {
  const teacher = await teacherForUser(req.user);
  if (!teacher) throw new HttpError(404, 'Teacher not found');
  const keys = (teacher.assignedClasses || []).map((k) => parseClassKey(k));
  if (!keys.length) return res.json({ success: true, data: [] });

  const students = await Student.find({
    school: req.schoolId, isActive: true, userId: { $ne: null },
    $or: keys.map((k) => (k.section ? { class: k.class, section: k.section } : { class: k.class })),
  }).sort({ class: 1, section: 1, rollNumber: 1 });

  const parentUsers = await User.find({ school: req.schoolId, _id: { $in: students.map((s) => s.parentUserId).filter(Boolean) }, isActive: true }).select('name');
  const parentName = new Map(parentUsers.map((u) => [String(u._id), u.name]));
  const extraParents = await Parent.find({ school: req.schoolId, children: { $in: students.map((s) => s._id) }, userId: { $ne: null } });

  const contacts = [];
  const seenParents = new Set();
  for (const s of students) {
    contacts.push({ type: 'student', _id: s._id, userId: s.userId, name: s.name, class: s.class, section: s.section, roomId: roomFor(req.user._id, s.userId) });
    const parentIds = new Set();
    if (s.parentUserId && parentName.has(String(s.parentUserId))) parentIds.add(String(s.parentUserId));
    extraParents.filter((p) => p.children.some((c) => String(c) === String(s._id))).forEach((p) => parentIds.add(String(p.userId)));
    for (const pid of parentIds) {
      if (seenParents.has(`${pid}:${s._id}`)) continue;
      seenParents.add(`${pid}:${s._id}`);
      const p = extraParents.find((x) => String(x.userId) === pid);
      contacts.push({
        type: 'parent', userId: pid, name: parentName.get(pid) || p?.name || 'Parent', childName: s.name,
        class: s.class, section: s.section, roomId: roomFor(req.user._id, pid),
      });
    }
  }
  const stats = await roomStats(req.schoolId, req.user._id, [...new Set(contacts.map((c) => c.roomId))]);
  res.json({ success: true, data: contacts.map((c) => ({ ...c, ...stats.get(c.roomId) })) });
});

// GET /api/chat/admin-contacts (admin) — everyone in the school with unread counts
const getAdminContacts = asyncHandler(async (req, res) => {
  const adminId = req.user._id;
  const school = req.schoolId;
  const [students, teachers, parents] = await Promise.all([
    Student.find({ school, isActive: true, userId: { $ne: null } }).select('name class section rollNumber userId'),
    Teacher.find({ school, isActive: true, userId: { $ne: null } }).select('name subjects userId'),
    Parent.find({ school, userId: { $ne: null } }).select('name userId children').populate('children', 'name class section rollNumber'),
  ]);

  const contacts = [
    ...students.map((s) => ({
      type: 'student', userId: s.userId, name: s.name, sub: `Class ${s.class}${s.section ? `-${s.section}` : ''}`,
      studentClass: s.class, studentSection: s.section, studentRoll: s.rollNumber, roomId: roomFor(adminId, s.userId),
    })),
    ...teachers.map((t) => ({ type: 'teacher', userId: t.userId, name: t.name, sub: t.subjects?.[0] || 'Teacher', roomId: roomFor(adminId, t.userId) })),
    ...parents.map((p) => {
      const child = p.children?.[0];
      return {
        type: 'parent', userId: p.userId, name: p.name, sub: child ? `Parent of ${child.name}` : 'Parent',
        childName: child?.name || null, childClass: child?.class || null, childSection: child?.section || null, childRoll: child?.rollNumber || null,
        roomId: roomFor(adminId, p.userId),
      };
    }),
  ];
  const stats = await roomStats(req.schoolId, adminId, contacts.map((c) => c.roomId));
  const data = contacts.map((c) => ({ ...c, ...stats.get(c.roomId) }));
  data.sort((a, b) => (b.unread - a.unread) || (new Date(b.lastTime || 0) - new Date(a.lastTime || 0)));
  res.json({ success: true, data });
});

module.exports = {
  getMyTeachers, getParentTeachers, getMessages, sendMessage, getBroadcasts,
  getAdminContact, getUnreadCount, getTeacherContacts, getAdminContacts,
};
