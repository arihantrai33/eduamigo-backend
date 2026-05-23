const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const { getMyNotes, getMyAssignments, uploadNote } = require('../controllers/noteController');

router.get('/my',          protect, getMyNotes);
router.get('/assignments', protect, getMyAssignments);
router.post('/upload',     protect, uploadNote);

module.exports = router;
