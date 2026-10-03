const express = require('express');
const router = express.Router();
const { protect, authorizeRoles, requirePermission } = require('../middleware/authMiddleware');
const c = require('../controllers/notificationController');
const { audited } = require('../middleware/auditTrail');

router.use(protect);
router.get('/my',     c.getMyNotifications);
router.patch('/read', c.markRead);
router.patch('/:id/read', (req, res, next) => { req.body = { ids: [req.params.id] }; next(); }, c.markRead);
router.post('/send',  requirePermission('communication.manage'), audited('notification.sent', 'notification', () => ''), c.sendNotification);
router.get('/',       requirePermission('communication.manage'), c.getAllNotifications);
router.delete('/:id', requirePermission('communication.manage'), audited('notification.deleted', 'notification'), c.deleteNotification);

module.exports = router;
