const mongoose = require('mongoose');
require('dotenv').config();

mongoose.connect(process.env.MONGO_URI).then(async () => {
  const User    = require('../models/User');
  const Teacher = require('../models/Teacher');

  const teachers = await Teacher.find({ userId: null }).lean();
  console.log(`Found ${teachers.length} unlinked teachers`);

  for (const t of teachers) {
    const user = await User.findOne({ 
      email: t.email,
      school: t.school 
    }).select('_id');
    
    if (user) {
      await Teacher.findByIdAndUpdate(t._id, { userId: user._id });
      console.log(`Linked: ${t.name} -> ${user._id}`);
    } else {
      console.log(`No user found for: ${t.name} (${t.email})`);
    }
  }

  process.exit();
});
