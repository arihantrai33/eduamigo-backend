const express = require('express');
const router = express.Router();
const { protect, authorizeRoles } = require('../middleware/authMiddleware');
const upload = require('../middleware/uploadMiddleware');
const c = require('../controllers/noteController');

router.use(protect);
router.get('/my',              authorizeRoles('student'), c.getMyNotes);
router.get('/assignments',     authorizeRoles('student'), c.getMyAssignments);
router.post('/upload',         authorizeRoles('teacher', 'admin'), upload.single('file'), c.uploadNote);
router.get('/teacher',         authorizeRoles('teacher', 'admin'), c.getTeacherUploads);
router.delete('/:id',          authorizeRoles('teacher', 'admin'), c.deleteNote);
router.post('/:id/reprocess',  authorizeRoles('teacher', 'admin'), c.reprocessNote);

module.exports = router;
