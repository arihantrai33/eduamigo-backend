const express = require('express');
const router = express.Router();
const { protect, authorizeRoles, requirePermission } = require('../middleware/authMiddleware');
const c = require('../controllers/attendanceController');

router.use(protect);
router.post('/mark',          requirePermission('attendance.mark'), c.markAttendance);
router.post('/bulk',          requirePermission('attendance.mark'), c.markBulkAttendance);
router.get('/today',          requirePermission('attendance.reports'), c.getTodaySummary);
router.get('/report',         requirePermission('attendance.reports'), c.getAttendanceReport);
router.get('/my-summary',     authorizeRoles('student'), c.getMyAttendanceSummary);
router.get('/child-summary',  authorizeRoles('parent'), c.getChildAttendanceSummary);
router.get('/child-records',  authorizeRoles('parent'), c.getChildAttendanceRecords);
router.get('/student/:studentId/summary', c.getStudentAttendance);
router.get('/class/:className', requirePermission('attendance.mark'), c.getClassAttendance);
router.get('/:studentId',     c.getStudentAttendance);

module.exports = router;
