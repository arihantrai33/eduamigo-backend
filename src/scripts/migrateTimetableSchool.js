const mongoose = require('mongoose');
require('dotenv').config();

const Timetable = require('../models/Timetable');
const User      = require('../models/User');

const migrate = async () => {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected to MongoDB');

  const school = await User.findOne({ role: 'admin' }).select('_id');
  if (!school) {
    console.error('No admin/school found — migration aborted');
    process.exit(1);
  }

  console.log(`Using school ID: ${school._id}`);

  const result = await Timetable.updateMany(
    { school: { $exists: false } },
    { $set: { school: school._id } }
  );

  console.log(`Migration done — ${result.modifiedCount} documents updated`);
  process.exit(0);
};

migrate().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
