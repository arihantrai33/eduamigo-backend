const mongoose = require('mongoose');
mongoose.connect('mongodb+srv://eduamigo_admin:rai628444@cluster0.rmyiph4.mongodb.net/eduamigo');
const Student = require('./src/models/Student');
async function run() {
  const student = await Student.findById('6a0bfa686fe7d3ba54c0d9cb');
  console.log(JSON.stringify(student, null, 2));
  process.exit();
}
run();
