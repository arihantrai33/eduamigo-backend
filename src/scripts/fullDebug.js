const mongoose = require('mongoose');
require('dotenv').config();

mongoose.connect(process.env.MONGO_URI).then(async () => {
  require('../models/User');
  const T = require('../models/Timetable');
  const Teacher = require('../models/Teacher');

  const tt = await T.findOne({ class: '9', section: 'A' }).populate({
    path: 'periods.teacher',
    select: 'name subject userId',
    populate: { path: 'userId', select: 'name' }
  });

  console.log('Periods:');
  for (const p of tt.periods) {
    console.log('  subject:', p.subject);
    console.log('  teacher:', p.teacher);
    console.log('  teacher.userId:', p.teacher?.userId);
    console.log('---');
  }

  process.exit();
});
