const express = require('express');
const router = express.Router();
const {
  markAttendance,
  getStudentAttendance,
  getClassAttendance
} = require('../controllers/attendanceController');

router.post('/mark', markAttendance);
router.get('/class/:className', getClassAttendance);
router.get('/:studentId', getStudentAttendance);

module.exports = router;