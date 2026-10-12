const Note = require('../models/Note');
const NoteEmbedding = require('../models/NoteEmbedding');
const cloudinary = require('../config/cloudinary');
const streamifier = require('streamifier');
const { HttpError, asyncHandler, assertId } = require('../utils/http');
const { parseClassKey, teacherCoversClass } = require('../utils/classes');
const { toDayKey } = require('../utils/dates');
const { studentForUser, teacherForUser } = require('../services/directory');

const TYPES = ['Notes', 'Assignment', 'Resource', 'Question Paper'];

function uploadBufferToCloudinary(buffer, originalName, school) {
  const safeName = String(originalName).replace(/\.[^/.]+$/, '').replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 60);
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      { resource_type: 'raw', folder: `eduamigo/${school}/notes`, public_id: `${Date.now()}_${safeName}.pdf` },
      (error, result) => (error ? reject(error) : resolve(result)),
    );
    streamifier.createReadStream(buffer).pipe(uploadStream);
  });
}

async function notesForStudent(req, types) {
  const student = await studentForUser(req.user);
  if (!student) throw new HttpError(404, 'Student not found');
  return Note.find({
    school: req.schoolId, class: student.class, section: { $in: [student.section, '', null] }, type: { $in: types },
  }).select('-processing.lockedUntil');
}

// GET /api/notes/my (student)
const getMyNotes = asyncHandler(async (req, res) => {
  const notes = await (await notesForStudent(req, ['Notes', 'Resource', 'Question Paper'])).sort((a, b) => b.createdAt - a.createdAt);
  res.json({ success: true, data: notes });
});

// GET /api/notes/assignments (student)
const getMyAssignments = asyncHandler(async (req, res) => {
  const list = (await notesForStudent(req, ['Assignment'])).sort((a, b) => new Date(a.dueDate || 0) - new Date(b.dueDate || 0));
  res.json({ success: true, data: list });
});

// POST /api/notes/upload (teacher of that class, or admin) — multipart with a PDF "file"
const uploadNote = asyncHandler(async (req, res) => {
  const { title, subject, dueDate } = req.body || {};
  const type = TYPES.includes(req.body?.type) ? req.body.type : 'Notes';
  const key = parseClassKey(req.body?.class, req.body?.section);
  if (!title || !subject || !key.class) throw new HttpError(400, 'Title, subject and class are required');
  if (!req.file) throw new HttpError(400, 'PDF file is required');
  if (type === 'Assignment' && !dueDate) throw new HttpError(400, 'Due date is required for assignments');

  if (req.user.role === 'teacher') {
    const teacher = await teacherForUser(req.user);
    if (!teacherCoversClass(teacher, key.class, key.section)) throw new HttpError(403, 'You are not assigned to this class');
  }

  const result = await uploadBufferToCloudinary(req.file.buffer, req.file.originalname, req.schoolId);
  const due = dueDate ? toDayKey(dueDate) : null;
  const note = await Note.create({
    school: req.schoolId, title: String(title).trim(), subject: String(subject).trim(), type,
    class: key.class, section: key.section,
    fileUrl: result.secure_url, fileName: req.file.originalname, fileSize: String(req.file.size),
    dueDate: due, teacherName: req.user.name, uploadedBy: req.user._id,
    status: due && due - new Date() < 86400000 ? 'Urgent' : 'Pending',
    processing: { status: type === 'Notes' ? 'pending' : 'skipped' },
  });
  res.status(201).json({ success: true, message: 'Uploaded successfully. It will be available in AI revision within a few minutes.', data: note });
});

// GET /api/notes/teacher (teacher: own uploads; admin: all uploads in the school)
const getTeacherUploads = asyncHandler(async (req, res) => {
  const filter = { school: req.schoolId };
  if (req.user.role === 'teacher') filter.uploadedBy = req.user._id;
  const notes = await Note.find(filter).sort({ createdAt: -1 });
  res.json({ success: true, data: notes });
});

// DELETE /api/notes/:id (uploader or admin) — also removes the note from AI revision
const deleteNote = asyncHandler(async (req, res) => {
  assertId(req.params.id);
  const note = await Note.findOne({ _id: req.params.id, school: req.schoolId });
  if (!note) throw new HttpError(404, 'Note not found');
  if (req.user.role !== 'admin' && String(note.uploadedBy) !== String(req.user._id)) {
    throw new HttpError(403, 'You can only delete your own uploads');
  }
  await NoteEmbedding.deleteMany({ noteId: note._id, school: req.schoolId });
  await Note.deleteOne({ _id: note._id, school: req.schoolId });
  res.json({ success: true, message: 'Deleted' });
});

// POST /api/notes/:id/reprocess (uploader or admin) — retry AI processing
const reprocessNote = asyncHandler(async (req, res) => {
  assertId(req.params.id);
  const note = await Note.findOne({ _id: req.params.id, school: req.schoolId, type: 'Notes' });
  if (!note) throw new HttpError(404, 'Note not found');
  if (req.user.role !== 'admin' && String(note.uploadedBy) !== String(req.user._id)) throw new HttpError(403, 'Not allowed');
  note.processing = { status: 'pending', attempts: 0, chunks: 0, error: null, lockedUntil: null };
  await note.save();
  res.json({ success: true, message: 'Queued for processing' });
});

module.exports = { getMyNotes, getMyAssignments, uploadNote, getTeacherUploads, deleteNote, reprocessNote };
