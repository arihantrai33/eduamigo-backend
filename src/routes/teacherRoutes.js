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
  getAssignments,
  putAssignments,
  deleteTeacher
} = require('../controllers/teacherController');
const { protect, authorizeRoles, requirePermission } = require('../middleware/authMiddleware');

// /me — MUST be before /:id
router.get('/me', protect, authorizeRoles('teacher'), getMe);

// All teachers + Create
router.route('/')
  .get(protect, requirePermission('teachers.read'), getTeachers)
  .post(protect, requirePermission('teachers.manage'), createTeacher);

// Class ke teachers
router.get('/class/:class', protect, authorizeRoles('admin', 'teacher', 'parent'), getTeachersByClass);

// Single teacher + Update + Delete
router.route('/:id')
  .get(protect, requirePermission('teachers.read'), getTeacher)
  .put(protect, requirePermission('teachers.manage'), updateTeacher)
  .delete(protect, requirePermission('teachers.manage'), deleteTeacher);

// Class assign/remove
router.patch('/:id/assign-class', protect, requirePermission('teachers.manage'), assignClass);
router.get('/:id/assignments', protect, requirePermission('teachers.manage'), getAssignments);
router.put('/:id/assignments', protect, requirePermission('teachers.manage'), putAssignments);
router.patch('/:id/remove-class', protect, requirePermission('teachers.manage'), removeClass);

module.exports = router;