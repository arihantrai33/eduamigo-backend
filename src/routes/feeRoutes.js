const express = require('express');
const router = express.Router();
const { protect, authorizeRoles } = require('../middleware/authMiddleware');
const c = require('../controllers/feeController');

router.use(protect);
router.get('/',             authorizeRoles('admin'), c.getFees);
router.post('/add',         authorizeRoles('admin'), c.addFee);
router.get('/all',          authorizeRoles('admin'), c.getAllPendingFees);
router.get('/pending/all',  authorizeRoles('admin'), c.getAllPendingFees);
router.get('/my',           authorizeRoles('student', 'parent'), c.getMyFees);
router.patch('/:feeId/pay', authorizeRoles('admin'), c.markFeePaid);
router.get('/:studentId',   authorizeRoles('admin'), c.getStudentFees);

module.exports = router;
