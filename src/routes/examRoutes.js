const express = require('express');
const router = express.Router();
const { protect, authorizeRoles, requirePermission } = require('../middleware/authMiddleware');
const c = require('../controllers/examController');
const { audited } = require('../middleware/auditTrail');

// Results are written only through the marks publish flow (/api/marks/publish).
router.use(protect);
router.get('/my-results',                  authorizeRoles('student'), c.getMyResults);
router.get('/child-results',               authorizeRoles('parent'), c.getChildResults);
router.get('/results',                     requirePermission('results.read'), c.getResults);
router.get('/student/:studentId/results',  c.getStudentResults);

router.get('/options', c.getOptions);
router.get('/',       c.listSchedule);
router.post('/',      requirePermission('exams.manage'), audited('exam.scheduled', 'exam'), c.createSchedule);
router.put('/:id',    requirePermission('exams.manage'), audited('exam.updated', 'exam'), c.updateSchedule);
router.delete('/:id', requirePermission('exams.manage'), audited('exam.cancelled', 'exam'), c.deleteSchedule);

module.exports = router;
