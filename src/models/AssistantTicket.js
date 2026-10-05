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
  title:      { type: String, default: null, maxlength: 140 },                  // professional one-line title for staff ("Maths marks query, Kabir Sharma 9-A")
  summary:    { type: String, default: null, maxlength: 500 },                  // professional summary for staff, written in English whatever language the person used
  requestedAction: { type: String, default: null, maxlength: 300 },             // what the person wants done
  entities:   { type: mongoose.Schema.Types.Mixed, default: null },             // student, class, subject, person: the facts the brief rests on
  priorityReason: { type: String, default: null, maxlength: 200 },              // why the priority is what it is (policy, not model opinion)
  lastActivityAt: { type: Date, default: Date.now },
  reason:     { type: String, enum: ['sensitive', 'complaint', 'requested', 'forwarded', 'unclear', 'not_covered'], required: true },
  priority:   { type: String, enum: ['normal', 'high'], default: 'normal' },
  team:       { type: String, required: true },                                  // owner key from domains.js
  assignees:  [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],          // people notified
  contacts:   [{ name: String, title: String, _id: false }],                    // who it was sent to, by name, as told to the person
  status:     { type: String, enum: ['open', 'in_progress', 'resolved'], default: 'open' },
  // Everything that happened after the first message: staff notes and the person's own follow-ups, escalations, reopenings.
  notes: [{
    by:   { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    kind: { type: String, enum: ['note', 'follow_up', 'escalation', 'reopen', 'repeat'], default: 'note' },
    text: { type: String, maxlength: 1000 },
    at:   { type: Date, default: Date.now },
    _id: false,
  }],
  reopenedCount: { type: Number, default: 0 },
  notifications: [{                                                             // proof of who was told: what the notify call really returned
    name: String, ok: Boolean, at: { type: Date, default: Date.now }, error: { type: String, maxlength: 200 }, _id: false,
  }],
  resolvedAt: { type: Date, default: null },
  // What the model said about safety, kept apart from the priority: model-asserted, and whether the message's own words confirmed it.
  modelSafety: { type: new mongoose.Schema({ category: String, corroborated: Boolean, by: String, injected: Boolean }, { _id: false }), default: null },
  // Same person, same child, same words, same two-minute window: one ticket, even when two requests arrive at the same moment.
  dedupeKey: { type: String, default: undefined },
  // Same person, child and wording, with no time window: lets an unconfirmed ticket be recognised if the same message is sent again later.
  textKey: { type: String, default: undefined },
  // Set when an action ran but could not be read back. Staff see it as "needs review"; it is cleared when the action is later confirmed
  // or a person handles the ticket, so nobody repeats the action unaware.
  verification: { type: new mongoose.Schema({ state: String, action: String, failed: [String], at: Date }, { _id: false }), default: undefined },
}, { timestamps: true });

assistantTicketSchema.index({ school: 1, number: 1 }, { unique: true });
assistantTicketSchema.index({ school: 1, raisedBy: 1, textKey: 1 });
assistantTicketSchema.index({ school: 1, dedupeKey: 1 }, { unique: true, partialFilterExpression: { dedupeKey: { $type: 'string' } } });
assistantTicketSchema.index({ school: 1, status: 1, createdAt: -1 });
assistantTicketSchema.index({ school: 1, assignees: 1, status: 1 });
assistantTicketSchema.index({ school: 1, raisedBy: 1, createdAt: -1 });
assistantTicketSchema.index({ school: 1, raisedBy: 1, status: 1, lastActivityAt: -1 });

module.exports = mongoose.model('AssistantTicket', assistantTicketSchema);
