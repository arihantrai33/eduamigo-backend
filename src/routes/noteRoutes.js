const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const upload = require('../middleware/uploadMiddleware');
const { getMyNotes, getMyAssignments, uploadNote, getTeacherUploads } = require('../controllers/noteController');

router.get('/my',           protect, getMyNotes);
router.get('/assignments',  protect, getMyAssignments);
router.post('/upload',      protect, upload.single('file'), uploadNote);
router.get('/teacher',      protect, getTeacherUploads);

module.exports = router;