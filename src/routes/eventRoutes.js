const express = require('express');
const router = express.Router();
const { protect, authorizeRoles, requirePermission } = require('../middleware/authMiddleware');
const c = require('../controllers/eventController');

router.use(protect);
router.get('/',       c.getAllEvents);
router.post('/',      requirePermission('communication.manage'), c.createEvent);
router.put('/:id',    requirePermission('communication.manage'), c.updateEvent);
router.delete('/:id', requirePermission('communication.manage'), c.deleteEvent);

module.exports = router;
