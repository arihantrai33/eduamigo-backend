const express = require('express');
const router = express.Router();
const { protect, requirePermission } = require('../middleware/authMiddleware');
const c = require('../controllers/markController');

router.use(protect);
router.get('/classes',     requirePermission('marks.enter'), c.getMyClasses);
router.get('/exams',       requirePermission('marks.enter'), c.getExamsForMarking);
router.get('/',            requirePermission('marks.enter'), c.getMarks);
router.post('/save',       requirePermission('marks.enter'), c.saveMarks);
router.patch('/publish',   requirePermission('marks.enter'), c.publishMarks);
router.patch('/unpublish', requirePermission('exams.manage'), c.unpublishMarks);

module.exports = router;
