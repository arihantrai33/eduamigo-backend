const mongoose = require('mongoose');
require('dotenv').config();

mongoose.connect(process.env.MONGO_URI).then(async () => {
  const User = require('../models/User');
  const users = await User.find({ role: 'teacher' }).select('name email').lean();
  console.log('Teacher users:', JSON.stringify(users, null, 2));
  process.exit();
});
