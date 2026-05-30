const mongoose = require('mongoose');
mongoose.connect('mongodb+srv://eduamigo_admin:rai628444@cluster0.rmyiph4.mongodb.net/eduamigo');
const Parent = require('./src/models/Parent');
async function run() {
  await Parent.updateOne(
    {email: 'parent@eduamigo.com'},
    {children: ['6a0eb4d1984fb68933a77c28']}
  );
  console.log('Parent linked to correct student');
  process.exit();
}
run();
