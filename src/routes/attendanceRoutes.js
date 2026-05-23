const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const {
  markAttendance,
  getStudentAttendance,
  getClassAttendance,
  getMyAttendanceSummary
} = require('../controllers/attendanceController');

router.post('/mark', protect, markAttendance);
router.get('/my-summary', protect, getMyAttendanceSummary);
router.get('/class/:className', protect, getClassAttendance);
router.get('/:studentId', getStudentAttendance);

module.exports = router;