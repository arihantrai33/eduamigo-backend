const express = require('express');
const router = express.Router();
const { protect, authorizeRoles } = require('../middleware/authMiddleware');
const { loginLimiter } = require('../middleware/rateLimit');
const c = require('../controllers/userController');

router.post('/login', loginLimiter, c.loginUser);

router.use(protect);
router.get('/profile', c.getProfile);
router.patch('/password', c.changePassword);
router.patch('/fcm-token', c.updateFcmToken);

router.post('/register', authorizeRoles('admin'), c.registerUser);
router.get('/', authorizeRoles('admin'), c.getAllUsers);
router.patch('/:id/toggle', authorizeRoles('admin'), c.toggleUserStatus);
router.post('/:id/reset-password', authorizeRoles('admin'), c.resetPassword);

module.exports = router;
