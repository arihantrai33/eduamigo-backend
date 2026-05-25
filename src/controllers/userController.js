const User = require('../models/User');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const registerUser = async (req, res) => {
  try {
    const { name, email, password, role, school } = req.body;
    const existing = await User.findOne({ email });
    if (existing) {
      return res.status(400).json({ success: false, message: 'Email already registered' });
    }
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await User.create({
      name, email,
      password: hashedPassword,
      role,
      school: school || null,
    });
    res.status(201).json({
      success: true,
      data: { _id: user._id, name: user.name, email: user.email, role: user.role, school: user.school },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

const loginUser = async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: 'Wrong password' });
    }
    if (user.school) {
      await user.populate("school", "name");
    }
    const token = jwt.sign(
      { id: user._id, role: user.role },
      process.env.JWT_SECRET || 'eduamigo_secret',
      { expiresIn: '7d' }
    );
    res.status(200).json({
      success: true,
      token,
      user: {
        _id:    user._id,
        name:   user.name,
        email:  user.email,
        role:   user.role,
        school: user.school?.name || user.school || null,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

const getProfile = async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('-password');
    res.status(200).json({ success: true, data: user });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

const updateFcmToken = async (req, res) => {
  try {
    const { fcmToken } = req.body;
    if (!fcmToken) {
      return res.status(400).json({ success: false, message: 'fcmToken required' });
    }
    await User.findByIdAndUpdate(req.user._id, { fcmToken });
    res.status(200).json({ success: true, message: 'FCM Token saved!' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

module.exports = { registerUser, loginUser, getProfile, updateFcmToken };