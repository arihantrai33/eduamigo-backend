const express = require('express');
const router = express.Router();
const { protect, authorizeRoles } = require('../middleware/authMiddleware');
const c = require('../controllers/notificationController');

router.use(protect);
router.get('/my',     c.getMyNotifications);
router.patch('/read', c.markRead);
router.patch('/:id/read', (req, res, next) => { req.body = { ids: [req.params.id] }; next(); }, c.markRead);
router.post('/send',  authorizeRoles('admin'), c.sendNotification);
router.get('/',       authorizeRoles('admin'), c.getAllNotifications);
router.delete('/:id', authorizeRoles('admin'), c.deleteNotification);

module.exports = router;
