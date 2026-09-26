const Note = require('../models/Note');
const Student = require('../models/Student');
const cloudinary = require('../config/cloudinary');
const streamifier = require('streamifier');

// Helper: upload a buffer to Cloudinary using a stream
function uploadBufferToCloudinary(buffer, originalName) {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        resource_type: 'raw', // PDFs are treated as raw files by Cloudinary
        folder: 'eduamigo_notes',
        public_id: `${Date.now()}_${originalName.replace(/\.[^/.]+$/, '')}`,
      },
      (error, result) => {
        if (error) reject(error);
        else resolve(result);
      }
    );
    streamifier.createReadStream(buffer).pipe(uploadStream);
  });
}

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

// POST /api/notes/upload — teacher note upload kare (real PDF file -> Cloudinary)
const uploadNote = async (req, res) => {
  try {
    const { title, subject, type, class: cls, section, dueDate } = req.body;

    if (!title || !subject || !cls) {
      return res.status(400).json({ success: false, message: 'title, subject, class are required' });
    }

    if (!req.file) {
      return res.status(400).json({ success: false, message: 'PDF file is required' });
    }

    const result = await uploadBufferToCloudinary(req.file.buffer, req.file.originalname);

    const note = await Note.create({
      title, subject, type, class: cls, section,
      fileUrl: result.secure_url,
      fileName: req.file.originalname,
      fileSize: req.file.size,
      dueDate,
      teacherName: req.user?.name || 'Teacher',
      uploadedBy: req.user._id,
      school: req.user.school._id,
      status: dueDate && new Date(dueDate) - new Date() < 86400000 ? 'Urgent' : 'Pending'
    });

    res.status(201).json({ success: true, message: 'Note uploaded successfully', data: note });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

const getTeacherUploads = async (req, res) => {
  try {
    const notes = await Note.find({ uploadedBy: req.user._id }).sort({ createdAt: -1 });
    res.json({ success: true, data: notes });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

module.exports = { getMyNotes, getMyAssignments, uploadNote, getTeacherUploads };