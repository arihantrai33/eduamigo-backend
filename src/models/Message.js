const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
  senderId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  receiverId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  roomId:     { type: String, required: true },
  text:       { type: String, required: true },
  read:       { type: Boolean, default: false },
  school:     { type: mongoose.Schema.Types.ObjectId, ref: 'School' },
}, { timestamps: true });

module.exports = mongoose.model('Message', messageSchema);
