const mongoose = require('mongoose');
mongoose.connect('mongodb+srv://eduamigo_admin:rai628444@cluster0.rmyiph4.mongodb.net/eduamigo');
const User = require('./src/models/User');
async function run() {
  const teachers = await User.find({role:'teacher'}).select('name email');
  console.log(JSON.stringify(teachers, null, 2));
  process.exit();
}
run();
