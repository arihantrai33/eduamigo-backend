require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const User = require('./src/models/User');

mongoose.connect(process.env.MONGO_URI).then(async () => {
  const hashed = await bcrypt.hash('parent123', 10);
  await User.create({
    name: 'Rajesh Kumar',
    email: 'parent@eduamigo.com',
    password: hashed,
    role: 'parent',
    phone: '9999999999',
  });
  console.log('Parent user created!');
  mongoose.disconnect();
}).catch(err => {
  console.error('Error:', err.message);
  mongoose.disconnect();
});
