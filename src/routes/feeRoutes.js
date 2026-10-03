const express = require('express');
const router = express.Router();
const { protect, authorizeRoles, requirePermission } = require('../middleware/authMiddleware');
const c = require('../controllers/feeController');
const { audited } = require('../middleware/auditTrail');

router.use(protect);
router.get('/',             requirePermission('fees.read'), c.getFees);
router.post('/add',         requirePermission('fees.structure'), audited('fee.created', 'student', 'studentId'), c.addFee);
router.get('/all',          requirePermission('fees.read'), c.getAllPendingFees);
router.get('/pending/all',  requirePermission('fees.read'), c.getAllPendingFees);
router.get('/my',           authorizeRoles('student', 'parent'), c.getMyFees);
router.patch('/:feeId/pay', requirePermission('fees.collect'), audited('fee.payment_recorded', 'fee', 'feeId'), c.markFeePaid);
router.get('/:feeId/receipts/:receiptNo', c.getReceipt);
router.get('/:studentId',   requirePermission('fees.read'), c.getStudentFees);

module.exports = router;
