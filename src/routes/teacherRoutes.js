const express = require('express');
const router  = express.Router();
const {
  getTeachers,
  getTeacher,
  getMe,
  getTeachersByClass,
  createTeacher,
  updateTeacher,
  assignClass,
  removeClass,
  deleteTeacher
} = require('../controllers/teacherController');
const { protect, authorizeRoles } = require('../middleware/authMiddleware');

// /me — MUST be before /:id
router.get('/me', protect, authorizeRoles('teacher'), getMe);

// All teachers + Create
router.route('/')
  .get(protect, authorizeRoles('admin', 'teacher'), getTeachers)
  .post(protect, authorizeRoles('admin'), createTeacher);

// Class ke teachers
router.get('/class/:class', protect, authorizeRoles('admin', 'teacher', 'parent'), getTeachersByClass);

// Single teacher + Update + Delete
router.route('/:id')
  .get(protect, authorizeRoles('admin', 'teacher'), getTeacher)
  .put(protect, authorizeRoles('admin'), updateTeacher)
  .delete(protect, authorizeRoles('admin'), deleteTeacher);

// Class assign/remove
router.patch('/:id/assign-class', protect, authorizeRoles('admin'), assignClass);
router.patch('/:id/remove-class', protect, authorizeRoles('admin'), removeClass);

module.exports = router;