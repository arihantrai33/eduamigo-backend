const express = require('express');
const router = express.Router();
const { protect, requirePermission } = require('../middleware/authMiddleware');
const c = require('../controllers/staffController');

// Employee records of non-teaching staff. Same permission as the rest of staff administration (HR).
router.use(protect);
router.get('/', requirePermission('hr.manage'), c.list);
router.put('/:userId', requirePermission('hr.manage'), c.save);

module.exports = router;
