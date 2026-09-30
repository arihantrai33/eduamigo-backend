const express = require('express');
const router  = express.Router();
const { protect, authorizeRoles, requirePermission } = require('../middleware/authMiddleware');
const uploadImage = require('../middleware/uploadImageMiddleware');
const {
  getStudents,
  getStudent,
  createStudent,
  updateStudent,
  deleteStudent,
  getMyProfile,
  getMyChild,
  getClasses,
  getSections,
} = require('../controllers/studentController');

// Dynamic classes & sections — Fee Structure ke liye
router.get('/classes',    protect, requirePermission('students.read'), getClasses);
router.get('/sections',   protect, requirePermission('students.read'), getSections);

// Student: own profile
router.get('/my-profile', protect, authorizeRoles('student'), getMyProfile);

// Parent: linked child's profile
router.get('/my-child',   protect, authorizeRoles('parent'), getMyChild);

// Admin/Teacher: all students
router.route('/')
  .get(protect,  requirePermission('students.read'), getStudents)
  .post(protect, requirePermission('students.manage'), uploadImage.single('photo'), createStudent);

// Admin: single student CRUD
router.route('/:id')
  .get(protect,    requirePermission('students.read'), getStudent)
  .put(protect,    requirePermission('students.manage'), uploadImage.single('photo'), updateStudent)
  .delete(protect, requirePermission('students.manage'),             deleteStudent);

module.exports = router;