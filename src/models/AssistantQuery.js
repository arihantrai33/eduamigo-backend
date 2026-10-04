const mongoose = require('mongoose');

// Log of every EduAmigo Ask question, used for the routing-accuracy and resolution metrics and the
// school's audit. The question is stored with contact details removed.
const partSchema = new mongoose.Schema({
  text:       { type: String, maxlength: 600 },
  domain:     { type: String, default: null },
  confidence: { type: Number, default: 0 },
  runnerUp:   { type: String, default: null },
  method:     { type: String, enum: ['keywords', 'model', 'context', 'choice', 'rule'], default: 'keywords' },
  action:     { type: String, enum: ['answer', 'clarify', 'handoff', 'blocked', 'no_data'], required: true },
  sources:    { type: Number, default: 0 },
  grounded:   { type: Boolean, default: true }, // every number in the answer came from the records
  ticket:     { type: mongoose.Schema.Types.ObjectId, ref: 'AssistantTicket', default: null },
}, { _id: false });

const assistantQuerySchema = new mongoose.Schema({
  school:       { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true },
  user:         { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  role:         { type: String, required: true },
  conversation: { type: mongoose.Schema.Types.ObjectId, ref: 'AssistantConversation' },
  text:         { type: String, maxlength: 1000 },
  language:     { type: String, enum: ['en', 'hi', 'hinglish'], default: 'en' },
  parts:        { type: [partSchema], default: [] },
  action:       { type: String, enum: ['answer', 'clarify', 'handoff', 'blocked', 'no_data'], required: true },
  latencyMs:    { type: Number, default: 0 },
  ai: {
    used:         { type: Boolean, default: false },
    provider:     { type: String, default: null },
    model:        { type: String, default: null },
    inputTokens:  { type: Number, default: 0 },
    outputTokens: { type: Number, default: 0 },
    rewritten:    { type: Boolean, default: false }, // the reply wording came from the model (numbers checked)
  },
  feedback: {
    helpful: { type: Boolean, default: null },
    at:      { type: Date, default: null },
  },
}, { timestamps: true });

assistantQuerySchema.index({ school: 1, createdAt: -1 });
assistantQuerySchema.index({ school: 1, user: 1, createdAt: -1 });

module.exports = mongoose.model('AssistantQuery', assistantQuerySchema);
