const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const {
  sendNotification,
  getAllNotifications,
  getMyNotifications,
  deleteNotification
} = require('../controllers/notificationController');

router.post('/send', protect, sendNotification);
router.get('/my', protect, getMyNotifications);
router.get('/', protect, getAllNotifications);
router.delete('/:id', protect, deleteNotification);

module.exports = router;