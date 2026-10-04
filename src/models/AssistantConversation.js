const mongoose = require('mongoose');

// One EduAmigo Ask chat. Holds what the assistant needs to understand follow-ups
// ("aur doosre bachche ki?") and pending clarifying questions. Old chats expire after 7 days.
const assistantConversationSchema = new mongoose.Schema({
  school: { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true },
  user:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  state: {
    lastDomain:    { type: String, default: null },
    lastStudentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Student', default: null },
    lastClass:     { type: String, default: null },
    // A question waiting for the user's choice: which topic, which child, which class, or a hand-off.
    pending: {
      text:     { type: String, default: null },
      kind:     { type: String, enum: ['domain', 'student', 'class', 'staff', 'handoff', null], default: null },
      domain:   { type: String, default: null },
      options:  { type: [{ label: String, value: String, type: { type: String }, _id: false }], default: [] },
      attempts: { type: Number, default: 0 },
    },
  },
  turns: { type: Number, default: 0 },
  lastActiveAt: { type: Date, default: Date.now },
}, { timestamps: true });

assistantConversationSchema.index({ school: 1, user: 1, lastActiveAt: -1 });
assistantConversationSchema.index({ lastActiveAt: 1 }, { expireAfterSeconds: 7 * 24 * 3600 });

module.exports = mongoose.model('AssistantConversation', assistantConversationSchema);
