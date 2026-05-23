const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const {
  getMyTeachers,
  getMessages,
  sendMessage,
  getBroadcasts,
  getAdminContact,
} = require('../controllers/chatController');

router.get('/teachers',         protect, getMyTeachers);
router.get('/messages/:roomId', protect, getMessages);
router.post('/messages',        protect, sendMessage);
router.get('/broadcasts',       protect, getBroadcasts);
router.get('/admin',            protect, getAdminContact);

module.exports = router;
