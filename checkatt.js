const mongoose = require('mongoose');
mongoose.connect('mongodb+srv://eduamigo_admin:rai628444@cluster0.rmyiph4.mongodb.net/eduamigo');
const Attendance = require('./src/models/Attendance');
async function run() {
  const count = await Attendance.countDocuments();
  console.log('Total attendance records in DB:', count);
  const sample = await Attendance.find().limit(3);
  console.log(JSON.stringify(sample, null, 2));
  process.exit();
}
run();
