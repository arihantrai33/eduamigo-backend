const mongoose = require('mongoose');

// A question EduAmigo Ask handed over to a person: a complaint, a safety concern, a payment dispute,
// a request for a person, or a question it could not route. Numbered per school (T-1001, T-1002, ...).
const assistantTicketSchema = new mongoose.Schema({
  school:     { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true },
  number:     { type: String, required: true },
  raisedBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  raisedRole: { type: String, required: true },
  student:    { type: mongoose.Schema.Types.ObjectId, ref: 'Student', default: null },
  domain:     { type: String, default: null },
  question:   { type: String, required: true, maxlength: 1000 },
  reason:     { type: String, enum: ['sensitive', 'requested', 'unclear', 'not_covered'], required: true },
  priority:   { type: String, enum: ['normal', 'high'], default: 'normal' },
  team:       { type: String, required: true },                                  // owner key from domains.js
  assignees:  [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],          // people notified
  status:     { type: String, enum: ['open', 'in_progress', 'resolved'], default: 'open' },
  notes: [{
    by:   { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    text: { type: String, maxlength: 1000 },
    at:   { type: Date, default: Date.now },
    _id: false,
  }],
  resolvedAt: { type: Date, default: null },
}, { timestamps: true });

assistantTicketSchema.index({ school: 1, number: 1 }, { unique: true });
assistantTicketSchema.index({ school: 1, status: 1, createdAt: -1 });
assistantTicketSchema.index({ school: 1, assignees: 1, status: 1 });
assistantTicketSchema.index({ school: 1, raisedBy: 1, createdAt: -1 });

module.exports = mongoose.model('AssistantTicket', assistantTicketSchema);
