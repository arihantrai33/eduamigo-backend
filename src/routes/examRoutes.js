const express = require('express');
const router = express.Router();
const {
  addResult,
  getStudentResults,
  getClassResults
} = require('../controllers/examController');

router.post('/result', addResult);
router.get('/class/:className', getClassResults);
router.get('/:studentId', getStudentResults);

module.exports = router;