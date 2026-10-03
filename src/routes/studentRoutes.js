const express = require('express');
const router  = express.Router();
const { protect, authorizeRoles, requirePermission } = require('../middleware/authMiddleware');
const uploadImage = require('../middleware/uploadImageMiddleware');
const { audited } = require('../middleware/auditTrail');
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
  getStudentHistory,
  resetStudentPassword,
  getTransferCertificate,
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
  .post(protect, requirePermission('students.manage'), uploadImage.single('photo'), audited('student.created', 'student'), createStudent);

// Admin, the student's teachers or parent: new temporary password for the student
router.post('/:id/reset-password', protect, resetStudentPassword);

// Staff: transfer certificate of a student who has left or passed out
router.get('/:id/transfer-certificate', protect, requirePermission('students.manage'), audited('student.tc_viewed', 'student'), getTransferCertificate);

// Staff: the student's class in every session
router.get('/:id/history', protect, requirePermission('students.read'), getStudentHistory);

// Admin: single student CRUD
router.route('/:id')
  .get(protect,    requirePermission('students.read'), getStudent)
  .put(protect,    requirePermission('students.manage'), uploadImage.single('photo'), audited('student.updated', 'student'), updateStudent)
  .delete(protect, requirePermission('students.manage'), audited('student.removed', 'student'), deleteStudent);

module.exports = router;