const express = require('express');
const router = express.Router();
const { protect, authorizeRoles } = require('../middleware/authMiddleware');
const c = require('../controllers/leaveController');

router.use(protect);
router.post('/apply',       c.applyLeave);
router.get('/my',           c.getMyLeaves);
router.get('/quota',        c.getMyQuota);
router.get('/pending',      authorizeRoles('admin', 'teacher'), c.getAllPendingLeaves);
router.get('/',             authorizeRoles('admin'), c.getAllLeaves);
router.patch('/:id/review', authorizeRoles('admin', 'teacher'), c.reviewLeave);
router.delete('/:id',       authorizeRoles('admin'), c.deleteLeave);

module.exports = router;
