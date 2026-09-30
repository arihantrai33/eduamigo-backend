const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
  senderId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  receiverId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  roomId:     { type: String, required: true },
  text:       { type: String, default: '' },
  fileUrl:    { type: String, default: null },
  fileName:   { type: String, default: null },
  fileType:   { type: String, default: null },
  read:       { type: Boolean, default: false },
  school:     { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true },
}, { timestamps: true });

messageSchema.index({ roomId: 1, createdAt: 1 });
messageSchema.index({ receiverId: 1, read: 1 });

module.exports = mongoose.model('Message', messageSchema);
