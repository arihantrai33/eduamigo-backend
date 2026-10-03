const express = require('express');
const router = express.Router();
const { protect, authorizeRoles, requirePermission } = require('../middleware/authMiddleware');
const c = require('../controllers/eventController');
const { audited } = require('../middleware/auditTrail');

router.use(protect);
router.get('/',       c.getAllEvents);
router.post('/',      requirePermission('communication.manage'), audited('event.created', 'event', () => ''), c.createEvent);
router.put('/:id',    requirePermission('communication.manage'), audited('event.updated', 'event'), c.updateEvent);
router.delete('/:id', requirePermission('communication.manage'), audited('event.deleted', 'event'), c.deleteEvent);

module.exports = router;
