const express = require('express');
const router = express.Router();
const { protect, authorizeRoles } = require('../middleware/authMiddleware');
const c = require('../controllers/eventController');

router.use(protect);
router.get('/',       c.getAllEvents);
router.post('/',      authorizeRoles('admin'), c.createEvent);
router.put('/:id',    authorizeRoles('admin'), c.updateEvent);
router.delete('/:id', authorizeRoles('admin'), c.deleteEvent);

module.exports = router;
