const mongoose = require('mongoose');
require('dotenv').config();
const bcrypt = require('bcryptjs');

mongoose.connect(process.env.MONGO_URI).then(async () => {
  const User    = require('../models/User');
  const Teacher = require('../models/Teacher');

  const teachers = await Teacher.find({ userId: null });
  console.log(`Found ${teachers.length} unlinked teachers`);

  for (const t of teachers) {
    // Check if user already exists with this email
    let user = await User.findOne({ email: t.email });
    
    if (!user) {
      const hashed = await bcrypt.hash(t.employeeId || 'Teacher@123', 10);
      user = await User.create({
        name:     t.name,
        email:    t.email,
        phone:    t.phone,
        password: hashed,
        role:     'teacher',
        school:   t.school,
      });
      console.log(`Created user for: ${t.name} | Login: ${t.email} / ${t.employeeId || 'Teacher@123'}`);
    }

    await Teacher.findByIdAndUpdate(t._id, { userId: user._id });
    console.log(`Linked: ${t.name} -> ${user._id}`);
  }

  process.exit();
});
