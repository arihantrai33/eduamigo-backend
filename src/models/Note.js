const mongoose = require('mongoose');

const noteSchema = new mongoose.Schema({
  school:     { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true },
  title:      { type: String, required: true, trim: true, maxlength: 200 },
  subject:    { type: String, required: true, trim: true },
  type:       { type: String, enum: ['Notes', 'Assignment', 'Resource', 'Question Paper'], default: 'Notes' },
  fileUrl:    { type: String },
  fileName:   { type: String },
  fileSize:   { type: String },
  uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  teacherName:{ type: String },
  // Canonical class ("10") and section ("A"); an empty section means all sections.
  class:      { type: String, required: true },
  section:    { type: String, default: '' },
  dueDate:    { type: Date },
  status:     { type: String, enum: ['Pending', 'Submitted', 'Urgent'], default: 'Pending' },

  // AI revision pipeline state
  processing: {
    status:      { type: String, enum: ['pending', 'processing', 'ready', 'failed', 'skipped'], default: 'pending' },
    attempts:    { type: Number, default: 0 },
    chunks:      { type: Number, default: 0 },
    error:       { type: String, default: null },
    lockedUntil: { type: Date, default: null },
    processedAt: { type: Date, default: null },
  },
}, { timestamps: true });

noteSchema.index({ school: 1, class: 1, section: 1, type: 1, createdAt: -1 });
noteSchema.index({ 'processing.status': 1, type: 1 });

module.exports = mongoose.model('Note', noteSchema);
