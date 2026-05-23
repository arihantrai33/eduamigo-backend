const express = require('express');
const router = express.Router();
const { addResult, getStudentResults, getClassResults, getMyResults } = require('../controllers/examController');
const { protect } = require('../middleware/authMiddleware');

// ⚠️ /my-results PEHLE hona chahiye /:studentId se
router.get('/my-results', protect, getMyResults);
router.get('/class/:className', getClassResults);
router.get('/:studentId', getStudentResults);
router.post('/result', addResult);

module.exports = router;