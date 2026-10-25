const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
  senderId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  receiverId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  roomId:     { type: String, required: true },
  text:       { type: String, default: '' },
  fileUrl:    { type: String, default: null },
  fileName:   { type: String, default: null },
  fileType:   { type: String, default: null },
  // Files sent with the message (photos, PDFs, voice notes, documents): private, see services/attachments.js.
  attachments: [new mongoose.Schema({ key: String, name: String, type: { type: String }, size: Number, kind: String }, { _id: false })],
  read:       { type: Boolean, default: false },
  school:     { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true },
}, { timestamps: true });

messageSchema.index({ roomId: 1, createdAt: 1 });
messageSchema.index({ receiverId: 1, read: 1 });

module.exports = mongoose.model('Message', messageSchema);
