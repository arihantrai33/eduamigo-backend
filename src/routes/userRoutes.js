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
router.post('/reset-temp', async (req, res) => {
  try {
    const bcrypt = require('bcryptjs');
    const hash = await bcrypt.hash('Test@123', 10);
    await User.findOneAndUpdate(
      { email: 'arihantrai33@gmail.com' },
      { password: hash }
    );
    res.json({ success: true, message: 'Password reset done!' });
  } catch(e) {
    res.json({ success: false, error: e.message });
  }
});

module.exports = router;