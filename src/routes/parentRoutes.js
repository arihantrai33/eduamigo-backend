const express = require('express');
const router = express.Router();
const { protect, authorizeRoles } = require('../middleware/authMiddleware');
const {
  createParent, getParentById,
  getParentByStudent, getParentDashboard
} = require('../controllers/parentController');

router.post('/', protect, authorizeRoles('admin'), createParent);
router.get('/dashboard/:studentId', protect, authorizeRoles('admin', 'parent'), getParentDashboard);
router.get('/student/:studentId', protect, authorizeRoles('admin'), getParentByStudent);
router.get('/:parentId', protect, authorizeRoles('admin', 'parent'), getParentById);

module.exports = router;