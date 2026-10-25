const mongoose = require('mongoose');

// A school's request for a demo, sent from the public website. It belongs to no school yet (there is no tenant to attach it
// to), so it has no `school` field, like PasswordReset. Only the platform owner reads these. Nothing is sent when one arrives.
const demoRequestSchema = new mongoose.Schema({
  name:        { type: String, required: true, trim: true, maxlength: 100 },
  schoolName:  { type: String, required: true, trim: true, maxlength: 150 },
  role:        { type: String, trim: true, maxlength: 60, default: '' },
  email:       { type: String, required: true, trim: true, lowercase: true, maxlength: 160 },
  phone:       { type: String, trim: true, maxlength: 20, default: '' },
  city:        { type: String, trim: true, maxlength: 80, default: '' },
  students:    { type: String, enum: ['', 'under-300', '300-1000', '1000-3000', 'over-3000'], default: '' },
  message:     { type: String, trim: true, maxlength: 1000, default: '' },
  // One row per email per day: a double click, a retry or two tabs submitting together cannot create two requests.
  dedupeKey:   { type: String, required: true },
  status:      { type: String, enum: ['new', 'contacted', 'closed'], default: 'new' },
}, { timestamps: true });

demoRequestSchema.index({ dedupeKey: 1 }, { unique: true });
demoRequestSchema.index({ createdAt: -1 });

module.exports = mongoose.model('DemoRequest', demoRequestSchema);
