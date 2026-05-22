const express = require('express');
const router = express.Router();
const { registerUser, loginUser, getProfile, updateFcmToken } = require('../controllers/userController');
const { protect } = require('../middleware/authMiddleware');

// POST /api/users/register
router.post('/register', registerUser);

// POST /api/users/login
router.post('/login', loginUser);

// GET /api/users/profile — Auth chahiye
router.get('/profile', protect, getProfile);

// PATCH /api/users/fcm-token — Auth chahiye
router.patch('/fcm-token', protect, updateFcmToken);

module.exports = router;