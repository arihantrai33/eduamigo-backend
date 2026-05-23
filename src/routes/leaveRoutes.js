const express = require('express');
const router = express.Router();
const {
  applyLeave,
  getMyLeaves,
  getMyQuota,
  getAllLeaves,
  getAllPendingLeaves,
  reviewLeave,
  deleteLeave
} = require('../controllers/leaveController');
const { protect, authorizeRoles } = require('../middleware/authMiddleware');

// Apply leave — Student, Parent, Teacher, Admin
router.post('/apply', protect, authorizeRoles('student', 'parent', 'teacher', 'admin'), applyLeave);

// My leaves — authenticated user ki apni
router.get('/my', protect, authorizeRoles('student', 'parent', 'teacher', 'admin'), getMyLeaves);

// My quota — leave balance
router.get('/quota', protect, authorizeRoles('student', 'parent', 'teacher', 'admin'), getMyQuota);

// Pending leaves — Admin / Teacher
router.get('/pending', protect, authorizeRoles('admin', 'teacher'), getAllPendingLeaves);

// All leaves — Admin only
router.get('/', protect, authorizeRoles('admin'), getAllLeaves);

// Approve / Reject — Admin / Teacher
router.patch('/:id/review', protect, authorizeRoles('admin', 'teacher'), reviewLeave);

// Delete — Admin only, non-pending only
router.delete('/:id', protect, authorizeRoles('admin'), deleteLeave);

module.exports = router;