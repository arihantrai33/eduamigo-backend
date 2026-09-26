const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const { askRevisionQuestion } = require('../controllers/revisionController');

router.post('/ask', protect, askRevisionQuestion);

module.exports = router;
