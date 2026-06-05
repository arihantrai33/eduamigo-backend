const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const {
  createAnnouncement,
  getAllAnnouncements,
  getMyAnnouncements,
  togglePin,
  deleteAnnouncement,
  updateAnnouncement
} = require('../controllers/announcementController');

router.get('/',        protect, getAllAnnouncements);
router.get('/my',      protect, getMyAnnouncements);
router.post('/',       protect, createAnnouncement);
router.put('/:id',     protect, updateAnnouncement);
router.patch('/:id/pin', protect, togglePin);
router.delete('/:id',  protect, deleteAnnouncement);

module.exports = router;
