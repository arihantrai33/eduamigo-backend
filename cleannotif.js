const mongoose = require('mongoose');
mongoose.connect('mongodb+srv://eduamigo_admin:rai628444@cluster0.rmyiph4.mongodb.net/eduamigo');
const Notification = require('./src/models/Notification');
async function run() {
  const all = await Notification.find({});
  console.log('Total:', all.length);
  all.forEach(n => console.log(n._id, '|', n.title, '|', n.message.substring(0, 50)));
  process.exit();
}
run();
