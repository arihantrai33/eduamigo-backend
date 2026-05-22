const express = require('express');
const router = express.Router();
const {
  applyLeave,
  getMyLeaves,
  getAllLeaves,
  getAllPendingLeaves,
  reviewLeave,
  deleteLeave
} = require('../controllers/leaveController');
const { protect, authorizeRoles } = require('../middleware/authMiddleware');

// Apply — Student, Parent, Teacher sab kar sakte hain
router.post('/apply', protect, authorizeRoles('student', 'parent', 'teacher', 'admin'), applyLeave);

// Apni leaves dekho — Student/Parent/Teacher
router.get('/my/:requestedBy', protect, authorizeRoles('student', 'parent', 'teacher', 'admin'), getMyLeaves);

// Pending leaves — Admin/Teacher
router.get('/pending', protect, authorizeRoles('admin', 'teacher'), getAllPendingLeaves);

// Saari leaves — Admin only
router.get('/', protect, authorizeRoles('admin'), getAllLeaves);

// Approve/Reject — Admin/Teacher
router.patch('/:id/review', protect, authorizeRoles('admin', 'teacher'), reviewLeave);

// Delete — Sirf Admin, sirf reviewed leaves
router.delete('/:id', protect, authorizeRoles('admin'), deleteLeave);

module.exports = router;