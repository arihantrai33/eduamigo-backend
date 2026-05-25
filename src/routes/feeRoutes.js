const express = require('express');
const router  = express.Router();
const { protect, authorizeRoles } = require('../middleware/authMiddleware');
const {
  addFee,
  getAllFees,
  getAllPendingFees,
  getStudentFees,
  getMyFees,
  markFeePaid,
} = require('../controllers/feeController');

router.post('/add',         protect, authorizeRoles('admin'),             addFee);
router.get('/all',          protect, authorizeRoles('admin'),             getAllFees);
router.get('/pending/all',  protect, authorizeRoles('admin'),             getAllPendingFees);
router.get('/my',           protect, authorizeRoles('student', 'parent'), getMyFees);
router.get('/:studentId',   protect, authorizeRoles('admin', 'teacher'),  getStudentFees);
router.patch('/:feeId/pay', protect, authorizeRoles('admin'),             markFeePaid);

module.exports = router;