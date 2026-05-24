const mongoose = require('mongoose');
require('dotenv').config();

mongoose.connect(process.env.MONGO_URI).then(async () => {
  require('../models/User');
  const T = require('../models/Timetable');
  const Teacher = require('../models/Teacher');

  const tt = await T.findOne({ class: '9', section: 'A' }).lean();
  const teacherId = tt?.periods?.[0]?.teacher;
  
  const teacher = await Teacher.findById(teacherId).lean();
  console.log('Teacher userId:', teacher?.userId);
  console.log('Teacher name:', teacher?.name);
  
  process.exit();
});
