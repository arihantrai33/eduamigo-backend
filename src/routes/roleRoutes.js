const express = require('express');
const router = express.Router();
const { protect, requirePermission } = require('../middleware/authMiddleware');
const c = require('../controllers/roleController');

// A school's roles: what each allows, made from templates or from scratch, and who holds them. Every route is tenant-scoped through
// protect; creating, changing and giving roles needs roles.manage and can only hand out what the person holds themselves.
router.use(protect);
router.get('/',                 requirePermission('roles.view'), c.list);
router.get('/recommendations', requirePermission('roles.view'), c.recommendations);
router.get('/access/:userId',   requirePermission('roles.view'), c.access);
router.post('/',                requirePermission('roles.manage'), c.create);
router.patch('/:id',            requirePermission('roles.manage'), c.update);
router.post('/:id/preview',     requirePermission('roles.manage'), c.preview);
router.delete('/:id',           requirePermission('roles.manage'), c.remove);

module.exports = router;
