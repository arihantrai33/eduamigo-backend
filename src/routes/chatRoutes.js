const express = require('express');
const router  = express.Router();
const { protect, authorizeRoles } = require('../middleware/authMiddleware');
const {
  getMyTeachers,
  getParentTeachers,
  getMessages,
  sendMessage,
  getBroadcasts,
  getAdminContact,
  getUnreadCount,
} = require('../controllers/chatController');

router.get('/unread-count',    protect, getUnreadCount);
router.get('/teachers',        protect, getMyTeachers);
router.get('/parent-teachers', protect, authorizeRoles('parent'), getParentTeachers);
router.get('/messages/:roomId',protect, getMessages);
router.post('/messages',       protect, sendMessage);
router.get('/broadcasts',      protect, getBroadcasts);
router.get('/admin',           protect, getAdminContact);

module.exports = router;