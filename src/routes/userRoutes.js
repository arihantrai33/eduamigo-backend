const express = require('express');
const router = express.Router();
const { registerUser, loginUser, getProfile, updateFcmToken, getAllUsers, toggleUserStatus } = require('../controllers/userController');
const { protect, authorizeRoles } = require('../middleware/authMiddleware');

router.post('/register', registerUser);
router.post('/login', loginUser);
router.get('/profile', protect, getProfile);
router.patch('/fcm-token', protect, updateFcmToken);
router.get('/', protect, authorizeRoles('admin'), getAllUsers);
router.patch('/:id/toggle', protect, authorizeRoles('admin'), toggleUserStatus);

module.exports = router;
