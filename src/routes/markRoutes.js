const express = require('express');
const router = express.Router();
const { protect, authorizeRoles } = require('../middleware/authMiddleware');
const c = require('../controllers/markController');

router.use(protect);
router.get('/classes',   authorizeRoles('teacher'), c.getMyClasses);
router.get('/students',  authorizeRoles('teacher'), c.getStudentsByClass);
router.get('/',          authorizeRoles('teacher', 'admin'), c.getMarks);
router.post('/save',     authorizeRoles('teacher'), c.saveMarks);
router.patch('/publish', authorizeRoles('teacher'), c.publishMarks);

module.exports = router;
