const mongoose = require('mongoose');

// A school office asks EduAmigo for help. The school can see its own requests and EduAmigo's public replies; internal notes are for the owner only.
const noteSchema = new mongoose.Schema({
  by:       { type: String, enum: ['school', 'platform'], required: true },
  author:   { type: String, default: '' },
  text:     { type: String, required: true, trim: true, maxlength: 2000 },
  internal: { type: Boolean, default: false },
  at:       { type: Date, default: Date.now },
  emailed:  { type: Boolean, default: undefined }, // for owner replies: whether the school was also emailed (owner view only)
}, { _id: false });

const supportRequestSchema = new mongoose.Schema({
  school:    { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  subject:   { type: String, required: true, trim: true, maxlength: 140 },
  category:  { type: String, enum: ['billing', 'technical', 'account', 'feature', 'other'], default: 'other' },
  priority:  { type: String, enum: ['low', 'normal', 'high'], default: 'normal' },
  status:    { type: String, enum: ['open', 'in_progress', 'resolved'], default: 'open' },
  assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  notes:     { type: [noteSchema], default: [] },
  resolvedAt: { type: Date, default: null },
}, { timestamps: true });
supportRequestSchema.index({ school: 1, createdAt: -1 });
supportRequestSchema.index({ status: 1, priority: 1, createdAt: -1 });

module.exports = mongoose.model('SupportRequest', supportRequestSchema);
