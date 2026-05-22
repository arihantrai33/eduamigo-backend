const express = require('express');
const router = express.Router();
const { protect, authorizeRoles } = require('../middleware/authMiddleware');
const {
  getStudents, getStudent, createStudent,
  updateStudent, deleteStudent, getMe
} = require('../controllers/studentController');

// ✅ /me route PEHLE hona chahiye /:id se
router.get('/me', protect, getMe);

router.route('/')
  .get(protect, authorizeRoles('admin', 'teacher'), getStudents)
  .post(protect, authorizeRoles('admin'), createStudent);

router.route('/:id')
  .get(protect, authorizeRoles('admin', 'teacher', 'parent'), getStudent)
  .put(protect, authorizeRoles('admin'), updateStudent)
  .delete(protect, authorizeRoles('admin'), deleteStudent);

module.exports = router;