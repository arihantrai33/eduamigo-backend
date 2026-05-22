const express = require('express');
const router = express.Router();
const {
  addFee,
  getStudentFees,
  markFeePaid,
  getAllPendingFees
} = require('../controllers/feeController');

router.post('/add', addFee);
router.get('/pending/all', getAllPendingFees);
router.get('/:studentId', getStudentFees);
router.patch('/:feeId/pay', markFeePaid);

module.exports = router;