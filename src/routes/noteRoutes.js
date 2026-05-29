const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const { getMyNotes, getMyAssignments, uploadNote, getTeacherUploads } = require('../controllers/noteController');

router.get('/my',          protect, getMyNotes);
router.get('/assignments', protect, getMyAssignments);
router.post('/upload',     protect, uploadNote);
router.get('/teacher',    protect, getTeacherUploads);

module.exports = router;
