const express = require('express');
const router = express.Router();
const { protect, authorizeRoles, requirePermission } = require('../middleware/authMiddleware');
const c = require('../controllers/bulkController');

router.use(protect, requirePermission('bulk.manage'));
router.post('/attendance',      c.bulkAttendance);
router.post('/promote',         c.bulkPromote);
router.post('/fee-reminder',    c.bulkFeeReminder);
router.post('/upload/students', c.bulkUploadStudents);
router.post('/upload/teachers', c.bulkUploadTeachers);

module.exports = router;
