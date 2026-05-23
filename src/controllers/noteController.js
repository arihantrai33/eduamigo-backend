const Note = require('../models/Note');
const Student = require('../models/Student');

// GET /api/notes/my — student ke class ke notes
const getMyNotes = async (req, res) => {
  try {
    const student = await Student.findOne({ userId: req.user._id });
    if (!student) return res.status(404).json({ success: false, message: 'Student not found' });

    const notes = await Note.find({
      class: student.class,
      section: student.section,
      type: { $in: ['Notes', 'Resource', 'Question Paper'] }
    }).sort({ createdAt: -1 });

    res.json({ success: true, data: notes });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

// GET /api/notes/assignments — student ke assignments
const getMyAssignments = async (req, res) => {
  try {
    const student = await Student.findOne({ userId: req.user._id });
    if (!student) return res.status(404).json({ success: false, message: 'Student not found' });

    const assignments = await Note.find({
      class: student.class,
      section: student.section,
      type: 'Assignment'
    }).sort({ dueDate: 1 });

    res.json({ success: true, data: assignments });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

// POST /api/notes/upload — teacher note upload kare
const uploadNote = async (req, res) => {
  try {
    const { title, subject, type, class: cls, section, fileUrl, fileName, fileSize, dueDate } = req.body;
    if (!title || !subject || !cls) {
      return res.status(400).json({ success: false, message: 'title, subject, class are required' });
    }

    const note = await Note.create({
      title, subject, type, class: cls, section,
      fileUrl, fileName, fileSize, dueDate,
      teacherName: req.user?.name || 'Teacher',
      uploadedBy: req.user._id,
      status: dueDate && new Date(dueDate) - new Date() < 86400000 ? 'Urgent' : 'Pending'
    });

    res.status(201).json({ success: true, message: 'Note uploaded successfully', data: note });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

module.exports = { getMyNotes, getMyAssignments, uploadNote };