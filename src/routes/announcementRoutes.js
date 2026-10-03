const express = require('express');
const router = express.Router();
const { protect, authorizeRoles, requirePermission } = require('../middleware/authMiddleware');
const c = require('../controllers/announcementController');
const { audited } = require('../middleware/auditTrail');

router.use(protect);
router.get('/my', c.getMyAnnouncements);
router.get('/',          requirePermission('communication.manage'), c.getAllAnnouncements);
router.post('/',         requirePermission('communication.manage'), audited('announcement.posted', 'announcement', () => ''), c.createAnnouncement);
router.put('/:id',       requirePermission('communication.manage'), audited('announcement.edited', 'announcement'), c.updateAnnouncement);
router.patch('/:id/pin', requirePermission('communication.manage'), c.togglePin);
router.delete('/:id',    requirePermission('communication.manage'), audited('announcement.deleted', 'announcement'), c.deleteAnnouncement);

module.exports = router;
