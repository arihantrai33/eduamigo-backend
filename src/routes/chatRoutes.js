const express = require('express');
const streamifier = require('streamifier');
const router = express.Router();
const { protect, authorizeRoles, requirePermission } = require('../middleware/authMiddleware');
const uploadAttachment = require('../middleware/uploadAttachmentMiddleware');
const uploadFiles = require('../middleware/uploadFiles');
const cloudinary = require('../config/cloudinary');
const { asyncHandler, HttpError } = require('../utils/http');
const c = require('../controllers/chatController');

router.use(protect);
router.get('/teacher-contacts', authorizeRoles('teacher'), c.getTeacherContacts);
router.get('/admin-contacts',   requirePermission('chat.directory'), c.getAdminContacts);
router.get('/unread-count',     c.getUnreadCount);
router.get('/inbox',            c.getInbox);
router.get('/teachers',         authorizeRoles('student'), c.getMyTeachers);
router.get('/parent-teachers',  authorizeRoles('parent'), c.getParentTeachers);
router.get('/messages/:roomId', c.getMessages);
router.post('/messages',        uploadFiles.array('files', 2), c.sendMessage);
router.get('/broadcasts',       authorizeRoles('student'), c.getBroadcasts);
router.get('/admin',            c.getAdminContact);

// POST /api/chat/upload (multipart "file") -> { url, fileName, fileType }
router.post('/upload', uploadAttachment.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) throw new HttpError(400, 'A file is required');
  const isPdf = req.file.mimetype === 'application/pdf';
  const result = await new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: `eduamigo/${req.schoolId}/chat`, resource_type: isPdf ? 'raw' : 'image' },
      (err, out) => (err ? reject(err) : resolve(out)),
    );
    streamifier.createReadStream(req.file.buffer).pipe(stream);
  });
  res.status(201).json({ success: true, url: result.secure_url, fileName: req.file.originalname, fileType: req.file.mimetype });
}));

module.exports = router;
