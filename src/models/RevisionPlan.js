const mongoose = require('mongoose');

// A student's Revision Planner schedule (src/learning/planner.js). The exam date is either one the student entered or one
// taken from the school's exam schedule (source says which); it is never guessed.
const itemSchema = new mongoose.Schema({
  id:      { type: String, required: true },
  subject: { type: String, required: true, maxlength: 40 },
  topic:   { type: String, required: true, maxlength: 120 },
  minutes: { type: Number, min: 10, max: 240, default: 45 },
  date:    { type: Date, required: true },     // calendar day (midnight UTC)
  kind:    { type: String, enum: ['study', 'practice', 'review'], default: 'study' },
  reason:  { type: String, maxlength: 160 },   // why it is here ("weak in practice: 1 of 4 correct")
  done:    { type: Boolean, default: false },
  doneAt:  { type: Date, default: null },
}, { _id: false });

const revisionPlanSchema = new mongoose.Schema({
  school:   { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true },
  user:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  title:    { type: String, maxlength: 120, default: 'Revision plan' },
  examDate: { type: Date, required: true },
  examSource: { type: String, enum: ['student', 'school'], required: true },
  startDate: { type: Date, required: true },
  minutesPerDay: { type: Number, min: 15, max: 480, required: true },
  restDays: { type: [Number], default: [] },   // 0 = Sunday
  items:    { type: [itemSchema], default: [] },
  warnings: { type: [String], default: [] },
  active:   { type: Boolean, default: true },
}, { timestamps: true });

revisionPlanSchema.index({ school: 1, user: 1, active: 1, updatedAt: -1 });

module.exports = mongoose.model('RevisionPlan', revisionPlanSchema);
