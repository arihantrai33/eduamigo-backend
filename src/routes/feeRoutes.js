const express = require('express');
const router = express.Router();
const { protect, authorizeRoles, requirePermission } = require('../middleware/authMiddleware');
const c = require('../controllers/feeController');

router.use(protect);
router.get('/',             requirePermission('fees.read'), c.getFees);
router.post('/add',         requirePermission('fees.structure'), c.addFee);
router.get('/all',          requirePermission('fees.read'), c.getAllPendingFees);
router.get('/pending/all',  requirePermission('fees.read'), c.getAllPendingFees);
router.get('/my',           authorizeRoles('student', 'parent'), c.getMyFees);
router.patch('/:feeId/pay', requirePermission('fees.collect'), c.markFeePaid);
router.get('/:studentId',   requirePermission('fees.read'), c.getStudentFees);

module.exports = router;
