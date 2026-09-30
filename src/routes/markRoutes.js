const express = require('express');
const router = express.Router();
const { protect, authorizeRoles, requirePermission } = require('../middleware/authMiddleware');
const c = require('../controllers/markController');

router.use(protect);
router.get('/classes',   requirePermission('marks.enter'), c.getMyClasses);
router.get('/students',  requirePermission('marks.enter'), c.getStudentsByClass);
router.get('/',          requirePermission('results.read'), c.getMarks);
router.post('/save',     requirePermission('marks.enter'), c.saveMarks);
router.patch('/publish', requirePermission('marks.enter'), c.publishMarks);

module.exports = router;
