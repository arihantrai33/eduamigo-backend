const mongoose = require('mongoose');

// One row per chat room, updated on every message. Keeps inbox lists fast
// (no scan over all messages to find the latest one).
const conversationSchema = new mongoose.Schema({
  school:       { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true },
  roomId:       { type: String, required: true, unique: true },
  participants: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  lastText:     { type: String, default: '' },
  lastAt:       { type: Date, default: null },
  lastSender:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true });

conversationSchema.index({ participants: 1, lastAt: -1 });

module.exports = mongoose.model('Conversation', conversationSchema);
