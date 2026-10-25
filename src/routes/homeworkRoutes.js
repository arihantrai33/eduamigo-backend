const express = require('express');
const router = express.Router();
const { protect, authorizeRoles, requirePermission } = require('../middleware/authMiddleware');
const upload = require('../middleware/uploadFiles');
const { audited } = require('../middleware/auditTrail');
const c = require('../controllers/homeworkController');

router.use(protect);
router.get('/my',     authorizeRoles('student'), c.mine);
router.get('/child',  authorizeRoles('parent'), c.ofChild);
router.post('/:id/done',   authorizeRoles('student'), c.markDone);
router.delete('/:id/done', authorizeRoles('student'), c.markUndone);

// Staff: the same permission as sharing study material, and only for the classes they teach.
router.post('/',      requirePermission('notes.upload'), upload.array('files', 3), audited('homework.created', 'homework'), c.create);
router.get('/',       requirePermission('notes.upload'), c.listForStaff);
router.get('/:id',    requirePermission('notes.upload'), c.detail);
router.delete('/:id', requirePermission('notes.upload'), audited('homework.removed', 'homework'), c.remove);

module.exports = router;
