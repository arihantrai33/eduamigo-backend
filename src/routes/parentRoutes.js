const express = require('express');
const router = express.Router();
const { protect, authorizeRoles, requirePermission } = require('../middleware/authMiddleware');
const {
  createParent,
  getAllParents,
  getMyChild,
  getParentById,
  getParentByStudent,
  getParentDashboard
} = require('../controllers/parentController');

router.get('/',                         protect, requirePermission('parents.read'), getAllParents);
router.post('/',                        protect, requirePermission('parents.manage'), createParent);
router.get('/my-child',                 protect, authorizeRoles('parent'), getMyChild);
router.get('/dashboard/:studentId',     protect, authorizeRoles('admin', 'parent'), getParentDashboard);
router.get('/student/:studentId',       protect, requirePermission('parents.read'), getParentByStudent);
router.get('/:parentId',               protect, authorizeRoles('admin', 'parent'), getParentById);

module.exports = router;