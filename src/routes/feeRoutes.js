const express = require('express');
const router = express.Router();
const { protect, authorizeRoles } = require('../middleware/authMiddleware');
const { addFee, getStudentFees, getMyFees, markFeePaid, getAllPendingFees } = require('../controllers/feeController');

router.post('/add', protect, authorizeRoles('admin'), addFee);
router.get('/my', protect, authorizeRoles('student', 'parent'), getMyFees);
router.get('/pending/all', protect, authorizeRoles('admin'), getAllPendingFees);
router.get('/:studentId', protect, authorizeRoles('admin', 'teacher'), getStudentFees);
router.patch('/:feeId/pay', protect, authorizeRoles('admin'), markFeePaid);

module.exports = router;