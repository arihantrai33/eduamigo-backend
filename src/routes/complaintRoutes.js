const express = require('express');
const router = express.Router();
const { protect, authorizeRoles } = require('../middleware/authMiddleware');
const { audited } = require('../middleware/auditTrail');
const c = require('../controllers/complaintController');

router.use(protect);
router.get('/child', authorizeRoles('parent'), c.ofChild);
router.post('/:id/reply', authorizeRoles('parent', 'teacher', 'admin', 'accountant', 'staff'), c.reply);
router.post('/',      authorizeRoles('teacher', 'admin', 'accountant', 'staff'), audited('complaint.created', 'complaint'), c.create);
router.get('/',       authorizeRoles('teacher', 'admin', 'accountant', 'staff'), c.listForStaff);
router.patch('/:id',  authorizeRoles('teacher', 'admin', 'accountant', 'staff'), audited('complaint.status_changed', 'complaint'), c.setStatus);

module.exports = router;
