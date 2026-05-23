const express = require('express');
const router = express.Router();
const {
  createTimetable,
  getClassTimetable,
  getClassDayTimetable,
  getTeacherTimetable,
  getMyTimetable,
  updateTimetable,
  deleteTimetable
} = require('../controllers/timetableController');
const { protect, authorizeRoles } = require('../middleware/authMiddleware');

router.post('/', protect, authorizeRoles('admin'), createTimetable);
router.get('/my', protect, authorizeRoles('student'), getMyTimetable); // ✅ pehle specific
router.get('/class/:class', protect, authorizeRoles('admin', 'teacher', 'parent', 'student'), getClassTimetable);
router.get('/class/:class/:day', protect, authorizeRoles('admin', 'teacher', 'parent', 'student'), getClassDayTimetable);
router.get('/teacher/:teacherId', protect, authorizeRoles('admin', 'teacher'), getTeacherTimetable);
router.put('/:id', protect, authorizeRoles('admin'), updateTimetable);
router.delete('/:id', protect, authorizeRoles('admin'), deleteTimetable);

module.exports = router;