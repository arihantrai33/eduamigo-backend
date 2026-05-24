const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const {
  markAttendance,
  getStudentAttendance,
  getClassAttendance,
  getMyAttendanceSummary,
  getChildAttendanceSummary,
  getChildAttendanceRecords,
} = require('../controllers/attendanceController');

router.post('/mark', protect, markAttendance);
router.get('/my-summary', protect, getMyAttendanceSummary);
router.get('/child-summary', protect, getChildAttendanceSummary);
router.get('/child-records', protect, getChildAttendanceRecords);
router.get('/student/:studentId/summary', protect, getStudentAttendance);
router.get('/class/:className', protect, getClassAttendance);
router.get('/:studentId', getStudentAttendance);

module.exports = router;