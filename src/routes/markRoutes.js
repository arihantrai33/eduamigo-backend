const express    = require('express');
const router     = express.Router();
const { getMyClasses, getStudentsByClass, getMarks, saveMarks, publishMarks } = require('../controllers/markController');
const { protect, authorizeRoles } = require('../middleware/authMiddleware');

router.get('/classes',  protect, authorizeRoles('teacher'), getMyClasses);
router.get('/students', protect, authorizeRoles('teacher'), getStudentsByClass);
router.get('/',         protect, authorizeRoles('teacher', 'admin'), getMarks);
router.post('/save',    protect, authorizeRoles('teacher'), saveMarks);
router.patch('/publish',protect, authorizeRoles('teacher'), publishMarks);

module.exports = router;