const mongoose = require('mongoose');

// One AI Tutor conversation of a student (src/learning). Only what the product needs: the turns (capped), the subject and
// mode, and per answer the reliability note and cited sources. Deleted by the student at any time, and automatically
// LEARNING_HISTORY_DAYS (default 180) after the last message. Previous AI answers are history, never treated as facts.
const turnSchema = new mongoose.Schema({
  role: { type: String, enum: ['user', 'assistant'], required: true },
  text: { type: String, required: true, maxlength: 8000 },
  meta: {
    confidence: { type: Object, default: null },
    sources: { type: [Object], default: undefined },
    checks: { type: [Object], default: undefined },
    diagrams: { type: [Object], default: undefined },
    voice: { type: Boolean, default: undefined },
  },
  at: { type: Date, default: Date.now },
}, { _id: false });

const HISTORY_DAYS = Number(process.env.LEARNING_HISTORY_DAYS || 180);

const learningConversationSchema = new mongoose.Schema({
  school:  { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true },
  user:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  student: { type: mongoose.Schema.Types.ObjectId, ref: 'Student', default: null },
  title:   { type: String, trim: true, maxlength: 120, default: 'New chat' },
  subject: { type: String, trim: true, maxlength: 40, default: null },
  mode:    { type: String, enum: ['tutor', 'guided'], default: 'tutor' },
  language: { type: String, enum: ['en', 'hi', 'hinglish', null], default: null },
  // What the conversation is about now (from the tutor's own hidden context note, validated): lets "this", "that step" and "ask me questions on it" mean something.
  topic:   { subject: { type: String, maxlength: 40, default: '' }, topic: { type: String, maxlength: 80, default: '' } },
  turns:   { type: [turnSchema], default: [] },
}, { timestamps: true });

learningConversationSchema.index({ school: 1, user: 1, updatedAt: -1 });
learningConversationSchema.index({ updatedAt: 1 }, { expireAfterSeconds: HISTORY_DAYS * 24 * 3600 });

module.exports = mongoose.model('LearningConversation', learningConversationSchema);
module.exports.MAX_TURNS = 40;
