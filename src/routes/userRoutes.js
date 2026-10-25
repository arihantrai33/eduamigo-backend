const express = require('express');
const router = express.Router();
const { protect, authorizeRoles, requirePermission } = require('../middleware/authMiddleware');
const { loginLimiter, loginAccountLimiter, passwordResetLimiter, schoolChoiceLimiter } = require('../middleware/rateLimit');
const c = require('../controllers/userController');
const { audited } = require('../middleware/auditTrail');
const roleController = require('../controllers/roleController');
const uploadImage = require('../middleware/uploadImageMiddleware');

router.post('/login', loginLimiter, loginAccountLimiter, c.loginUser);
router.post('/login/school', schoolChoiceLimiter, c.chooseSchool);
router.post('/otp/request', passwordResetLimiter, c.requestLoginCode);
router.post('/otp/verify', loginLimiter, loginAccountLimiter, c.loginWithCode);
router.post('/forgot-password', passwordResetLimiter, c.forgotPassword);
router.post('/reset-password', passwordResetLimiter, c.resetPasswordWithCode);

router.use(protect);
router.get('/profile', c.getProfile);
router.put('/me/avatar', uploadImage.single('photo'), c.setAvatar);
router.delete('/me/avatar', c.removeAvatar);
router.patch('/password', c.changePassword);
router.patch('/fcm-token', c.updateFcmToken);
router.delete('/fcm-token', c.removeFcmToken);
router.post('/logout-all', c.logoutAll);

router.post('/register', requirePermission('users.manage'), audited('user.created', 'user', 'email'), c.registerUser);
router.get('/', requirePermission('users.manage'), c.getAllUsers);
router.put('/:id/roles',        requirePermission('roles.manage'), roleController.assign);
router.patch('/:id/toggle', requirePermission('users.manage'), audited('user.status_toggled', 'user'), c.toggleUserStatus);
router.post('/:id/reset-password', requirePermission('users.manage'), audited('user.password_reset', 'user'), c.resetPassword);

module.exports = router;
