const express = require('express');
const router = express.Router();
const { protect, authorizeRoles, requirePermission } = require('../middleware/authMiddleware');
const { loginLimiter, loginAccountLimiter, passwordResetLimiter } = require('../middleware/rateLimit');
const c = require('../controllers/userController');
const { audited } = require('../middleware/auditTrail');

router.post('/login', loginLimiter, loginAccountLimiter, c.loginUser);
router.post('/forgot-password', passwordResetLimiter, c.forgotPassword);
router.post('/reset-password', passwordResetLimiter, c.resetPasswordWithCode);

router.use(protect);
router.get('/profile', c.getProfile);
router.patch('/password', c.changePassword);
router.patch('/fcm-token', c.updateFcmToken);
router.delete('/fcm-token', c.removeFcmToken);
router.post('/logout-all', c.logoutAll);

router.post('/register', requirePermission('users.manage'), audited('user.created', 'user', 'email'), c.registerUser);
router.get('/', requirePermission('users.manage'), c.getAllUsers);
router.patch('/:id/toggle', requirePermission('users.manage'), audited('user.status_toggled', 'user'), c.toggleUserStatus);
router.post('/:id/reset-password', requirePermission('users.manage'), audited('user.password_reset', 'user'), c.resetPassword);

module.exports = router;
