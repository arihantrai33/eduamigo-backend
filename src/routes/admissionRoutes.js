const express = require('express');
const router = express.Router();
const { protect, requirePermission } = require('../middleware/authMiddleware');
const c = require('../controllers/admissionController');

router.use(protect, requirePermission('admissions.manage'));
router.get('/', c.list);
router.post('/', c.create);
router.put('/:id', c.update);
router.patch('/:id/status', c.setStatus);
router.get('/:id/admit-defaults', c.admitDefaults);
router.post('/:id/admit', c.admit);

module.exports = router;
