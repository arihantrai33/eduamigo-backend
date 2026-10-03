const express = require('express');
const router = express.Router();
const { protect, authorizeRoles, requirePermission } = require('../middleware/authMiddleware');
const { loginLimiter, passwordResetLimiter } = require('../middleware/rateLimit');
const c = require('../controllers/userController');

router.post('/login', loginLimiter, c.loginUser);
router.post('/forgot-password', passwordResetLimiter, c.forgotPassword);
router.post('/reset-password', passwordResetLimiter, c.resetPasswordWithCode);

router.use(protect);
router.get('/profile', c.getProfile);
router.patch('/password', c.changePassword);
router.patch('/fcm-token', c.updateFcmToken);
router.post('/logout-all', c.logoutAll);

router.post('/register', requirePermission('users.manage'), c.registerUser);
router.get('/', requirePermission('users.manage'), c.getAllUsers);
router.patch('/:id/toggle', requirePermission('users.manage'), c.toggleUserStatus);
router.post('/:id/reset-password', requirePermission('users.manage'), c.resetPassword);

module.exports = router;
