const express = require('express');
const router = express.Router();
const { protect, authorizeRoles, requirePermission } = require('../middleware/authMiddleware');
const c = require('../controllers/announcementController');

router.use(protect);
router.get('/my', c.getMyAnnouncements);
router.get('/',          requirePermission('communication.manage'), c.getAllAnnouncements);
router.post('/',         requirePermission('communication.manage'), c.createAnnouncement);
router.put('/:id',       requirePermission('communication.manage'), c.updateAnnouncement);
router.patch('/:id/pin', requirePermission('communication.manage'), c.togglePin);
router.delete('/:id',    requirePermission('communication.manage'), c.deleteAnnouncement);

module.exports = router;
