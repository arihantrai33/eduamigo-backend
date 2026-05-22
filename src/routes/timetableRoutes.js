const express = require('express');
const router = express.Router();
const {
  createTimetable,
  getClassTimetable,
  getClassDayTimetable,
  getTeacherTimetable,
  updateTimetable,
  deleteTimetable
} = require('../controllers/timetableController');
const { protect, authorizeRoles } = require('../middleware/authMiddleware');

// Create — Admin only
router.post('/', protect, authorizeRoles('admin'), createTimetable);

// Class ka pura timetable — Admin/Teacher/Parent/Student
router.get('/class/:class', protect, authorizeRoles('admin', 'teacher', 'parent', 'student'), getClassTimetable);

// Class ka ek din ka timetable
router.get('/class/:class/:day', protect, authorizeRoles('admin', 'teacher', 'parent', 'student'), getClassDayTimetable);

// Teacher ka apna schedule
router.get('/teacher/:teacherId', protect, authorizeRoles('admin', 'teacher'), getTeacherTimetable);

// Update — Admin only
router.put('/:id', protect, authorizeRoles('admin'), updateTimetable);

// Delete — Admin only
router.delete('/:id', protect, authorizeRoles('admin'), deleteTimetable);

module.exports = router;