const express = require('express');
const router = express.Router();
const { protect, authorizeRoles } = require('../middleware/authMiddleware');
const c = require('../controllers/announcementController');

router.use(protect);
router.get('/my', c.getMyAnnouncements);
router.get('/',          authorizeRoles('admin'), c.getAllAnnouncements);
router.post('/',         authorizeRoles('admin'), c.createAnnouncement);
router.put('/:id',       authorizeRoles('admin'), c.updateAnnouncement);
router.patch('/:id/pin', authorizeRoles('admin'), c.togglePin);
router.delete('/:id',    authorizeRoles('admin'), c.deleteAnnouncement);

module.exports = router;
