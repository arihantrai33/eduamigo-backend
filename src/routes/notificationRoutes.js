const express = require('express');
const router = express.Router();
const {
  sendNotification,
  getAllNotifications,
  deleteNotification
} = require('../controllers/notificationController');

router.post('/send', sendNotification);
router.get('/', getAllNotifications);
router.delete('/:id', deleteNotification);

module.exports = router;