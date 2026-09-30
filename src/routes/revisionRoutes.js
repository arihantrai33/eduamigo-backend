const express = require('express');
const router = express.Router();
const { protect, authorizeRoles } = require('../middleware/authMiddleware');
const { revisionLimiter } = require('../middleware/rateLimit');
const { askRevisionQuestion } = require('../controllers/revisionController');

router.post('/ask', protect, authorizeRoles('student'), revisionLimiter, askRevisionQuestion);

module.exports = router;
