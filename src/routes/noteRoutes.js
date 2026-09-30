const express = require('express');
const router = express.Router();
const { protect, authorizeRoles, requirePermission } = require('../middleware/authMiddleware');
const upload = require('../middleware/uploadMiddleware');
const c = require('../controllers/noteController');

router.use(protect);
router.get('/my',              authorizeRoles('student'), c.getMyNotes);
router.get('/assignments',     authorizeRoles('student'), c.getMyAssignments);
router.post('/upload',         requirePermission('notes.upload'), upload.single('file'), c.uploadNote);
router.get('/teacher',         requirePermission('notes.upload'), c.getTeacherUploads);
router.delete('/:id',          requirePermission('notes.upload'), c.deleteNote);
router.post('/:id/reprocess',  requirePermission('notes.upload'), c.reprocessNote);

module.exports = router;
