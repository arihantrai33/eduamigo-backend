const express = require('express');
const router = express.Router();
const { protect, requirePermission } = require('../middleware/authMiddleware');
const c = require('../controllers/markController');
const { audited } = require('../middleware/auditTrail');

router.use(protect);
router.get('/classes',     requirePermission('marks.enter'), c.getMyClasses);
router.get('/exams',       requirePermission('marks.enter'), c.getExamsForMarking);
router.get('/',            requirePermission('marks.enter'), c.getMarks);
router.post('/save',       requirePermission('marks.enter'), audited('marks.saved', 'exam', (r) => r.body?.examId), c.saveMarks);
router.patch('/publish',   requirePermission('marks.enter'), audited('marks.published', 'exam', (r) => r.body?.examId), c.publishMarks);
router.patch('/unpublish', requirePermission('exams.manage'), audited('marks.reopened', 'exam', (r) => r.body?.examId), c.unpublishMarks);

module.exports = router;
