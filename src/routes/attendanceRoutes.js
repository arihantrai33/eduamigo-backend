const express = require('express');
const router = express.Router();
const { protect, authorizeRoles } = require('../middleware/authMiddleware');
const c = require('../controllers/attendanceController');

router.use(protect);
router.post('/mark',          authorizeRoles('admin', 'teacher'), c.markAttendance);
router.post('/bulk',          authorizeRoles('admin', 'teacher'), c.markBulkAttendance);
router.get('/today',          authorizeRoles('admin'), c.getTodaySummary);
router.get('/report',         authorizeRoles('admin'), c.getAttendanceReport);
router.get('/my-summary',     authorizeRoles('student'), c.getMyAttendanceSummary);
router.get('/child-summary',  authorizeRoles('parent'), c.getChildAttendanceSummary);
router.get('/child-records',  authorizeRoles('parent'), c.getChildAttendanceRecords);
router.get('/student/:studentId/summary', c.getStudentAttendance);
router.get('/class/:className', authorizeRoles('admin', 'teacher'), c.getClassAttendance);
router.get('/:studentId',     c.getStudentAttendance);

module.exports = router;
