const mongoose = require('mongoose');

// Log of every EduAmigo Ask question, used for the routing-accuracy and resolution metrics and the
// school's audit. The question is stored with contact details removed.
const partSchema = new mongoose.Schema({
  text:       { type: String, maxlength: 600 },
  domain:     { type: String, default: null },
  confidence: { type: Number, default: 0 },
  runnerUp:   { type: String, default: null },
  method:     { type: String, enum: ['keywords', 'model', 'context', 'choice', 'rule'], default: 'keywords' },
  // error = the records could not be read (a failure, never reported as "nothing found")
  action:     { type: String, enum: ['answer', 'clarify', 'handoff', 'blocked', 'no_data', 'error'], required: true },
  sources:    { type: Number, default: 0 },
  grounded:   { type: Boolean, default: true }, // an answer: at least one real record or document was read for it
  composition: { type: String, enum: ['standard', 'composed', 'kept_original'], default: 'standard' }, // model-written answer accepted, or thrown away by the number and name check
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
  action:       { type: String, enum: ['answer', 'clarify', 'handoff', 'blocked', 'no_data', 'error'], required: true },
  latencyMs:    { type: Number, default: 0 },
  requestId:    { type: String, default: null },
  // What the request did, step by step (no message text): [{ step, ms, ok, ...small details }]. For debugging and the dashboard.
  trace:        { type: [mongoose.Schema.Types.Mixed], default: [] },
  actions:      { type: [{ name: String, state: String, failed: [String], outcome: String, ok: Boolean, verified: Boolean, ticket: String, _id: false }], default: [] },
  ai: {
    used:         { type: Boolean, default: false },
    provider:     { type: String, default: null },
    model:        { type: String, default: null },
    inputTokens:  { type: Number, default: 0 },
    outputTokens: { type: Number, default: 0 },
    rewritten:    { type: Boolean, default: false }, // the reply wording came from the model (numbers checked)
    composed:     { type: Boolean, default: false }, // the answer was written for the exact question from the facts (numbers and names checked)
  },
  feedback: {
    helpful: { type: Boolean, default: null },
    at:      { type: Date, default: null },
  },
}, { timestamps: true });

assistantQuerySchema.index({ school: 1, createdAt: -1 });
assistantQuerySchema.index({ school: 1, user: 1, createdAt: -1 });

module.exports = mongoose.model('AssistantQuery', assistantQuerySchema);
