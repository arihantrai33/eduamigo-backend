const express = require('express');
const router  = express.Router();
const { protect, authorizeRoles } = require('../middleware/authMiddleware');
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
router.get('/classes',    protect, authorizeRoles('admin', 'teacher'), getClasses);
router.get('/sections',   protect, authorizeRoles('admin', 'teacher'), getSections);

// Student: own profile
router.get('/my-profile', protect, authorizeRoles('student'), getMyProfile);

// Parent: linked child's profile
router.get('/my-child',   protect, authorizeRoles('parent'), getMyChild);

// Admin/Teacher: all students
router.route('/')
  .get(protect,  authorizeRoles('admin', 'teacher'), getStudents)
  .post(protect, authorizeRoles('admin'), uploadImage.single('photo'), createStudent);

// Admin: single student CRUD
router.route('/:id')
  .get(protect,    authorizeRoles('admin', 'teacher'), getStudent)
  .put(protect,    authorizeRoles('admin'), uploadImage.single('photo'), updateStudent)
  .delete(protect, authorizeRoles('admin'),             deleteStudent);

module.exports = router;