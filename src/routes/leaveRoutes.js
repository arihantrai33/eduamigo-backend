const express = require('express');
const router = express.Router();
const { protect, authorizeRoles, requirePermission } = require('../middleware/authMiddleware');
const c = require('../controllers/leaveController');

router.use(protect);
router.post('/apply',       c.applyLeave);
router.get('/my',           c.getMyLeaves);
router.get('/quota',        c.getMyQuota);
router.get('/pending',      requirePermission('leaves.review'), c.getAllPendingLeaves);
router.get('/',             requirePermission('leaves.all'), c.getAllLeaves);
router.patch('/:id/review', requirePermission('leaves.review'), c.reviewLeave);
router.delete('/:id',       requirePermission('leaves.all'), c.deleteLeave);

module.exports = router;
