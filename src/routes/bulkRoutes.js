const express = require('express');
const router = express.Router();
const { protect, requirePermission, requireFeature } = require('../middleware/authMiddleware');
const c = require('../controllers/bulkController');
const { audited } = require('../middleware/auditTrail');

router.use(protect, requirePermission('bulk.manage'));
router.post('/attendance',      audited('attendance.bulk_marked', 'class', 'className'), c.bulkAttendance);
router.post('/promote',         audited('students.promoted', 'class', 'fromClass'), c.bulkPromote);
router.post('/fee-reminder',    requireFeature('fees'), c.bulkFeeReminder);
router.post('/upload/students', audited('students.uploaded', 'student', () => ''), c.bulkUploadStudents);
router.post('/upload/teachers', audited('teachers.uploaded', 'teacher', () => ''), c.bulkUploadTeachers);

module.exports = router;
