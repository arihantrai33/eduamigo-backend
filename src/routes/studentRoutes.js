const express = require('express');
const router  = express.Router();
const { protect, authorizeRoles } = require('../middleware/authMiddleware');
const {
  getStudents,
  getStudent,
  createStudent,
  updateStudent,
  deleteStudent,
  getMyProfile,
  getMyChild,
} = require('../controllers/studentController');

// Student: apna profile dekhe
router.get('/my-profile', protect, authorizeRoles('student'), getMyProfile);

// Parent: apne bachche ka profile dekhe
router.get('/my-child', protect, authorizeRoles('parent'), getMyChild);

// Admin/Teacher: all students
router.route('/')
  .get(protect,  authorizeRoles('admin', 'teacher'), getStudents)
  .post(protect, authorizeRoles('admin'),            createStudent);

// Admin: single student CRUD
router.route('/:id')
  .get(protect,    authorizeRoles('admin', 'teacher'), getStudent)
  .put(protect,    authorizeRoles('admin'),            updateStudent)
  .delete(protect, authorizeRoles('admin'),            deleteStudent);

module.exports = router;