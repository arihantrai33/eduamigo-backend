const mongoose = require('mongoose');

// A Practice & Assessment set (src/learning/practice.js). Practice only: never an official or graded assessment.
// The answer key, worked solution and marking points stay on the server; a question's solution is sent to the student only
// after they answer it (or choose to see it), and is checked first (mathcheck.js) where it is a calculation.
const questionSchema = new mongoose.Schema({
  id:        { type: String, required: true },
  format:    { type: String, enum: ['mcq', 'short', 'numeric'], required: true },
  difficulty: { type: String, enum: ['easy', 'medium', 'hard'], default: 'medium' },
  topic:     { type: String, maxlength: 80 },
  prompt:    { type: String, required: true, maxlength: 1200 },
  options:   { type: [String], default: undefined },     // mcq
  answer:    { type: String, required: true, maxlength: 600 }, // mcq: the correct option text; numeric: the value; short: a model answer
  accept:    { type: [String], default: undefined },      // other accepted answers (equivalent forms)
  points:    { type: [String], default: undefined },      // short: what a full answer must contain
  hint:      { type: String, maxlength: 600 },
  solution:  { type: String, maxlength: 3000 },
  check:     { type: Object, default: null },             // the calculation check that was run on the key
}, { _id: false });

const attemptSchema = new mongoose.Schema({
  questionId: { type: String, required: true },
  answer:     { type: String, maxlength: 2000 },
  verdict:    { type: String, enum: ['correct', 'partly', 'incorrect', 'revealed'], required: true },
  feedback:   { type: String, maxlength: 2000 },
  method:     { type: String, enum: ['exact', 'number', 'model', 'rule', 'revealed'] },
  at:         { type: Date, default: Date.now },
}, { _id: false });

const practiceSessionSchema = new mongoose.Schema({
  school:    { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true },
  user:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  student:   { type: mongoose.Schema.Types.ObjectId, ref: 'Student', default: null },
  class:     { type: String },
  subject:   { type: String, required: true, maxlength: 40 },
  topic:     { type: String, maxlength: 80, default: '' },
  difficulty: { type: String, enum: ['easy', 'medium', 'hard'], default: 'medium' },
  language:  { type: String, default: 'en' },
  questions: { type: [questionSchema], default: [] },
  attempts:  { type: [attemptSchema], default: [] },
  dropped:   { type: Number, default: 0 },  // generated questions that failed validation and were not shown
  usedMaterial: { type: [Object], default: undefined },
}, { timestamps: true });

practiceSessionSchema.index({ school: 1, user: 1, createdAt: -1 });
practiceSessionSchema.index({ school: 1, user: 1, subject: 1, topic: 1 });

module.exports = mongoose.model('PracticeSession', practiceSessionSchema);
