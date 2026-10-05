const mongoose = require('mongoose');

// A written school document EduAmigo Ask may answer from: handbook, policy, FAQ, circular. The admin adds it
// (pasted text or a PDF); it is split into sections so an answer can cite the exact section it came from.
const sectionSchema = new mongoose.Schema({
  heading: { type: String, default: '', maxlength: 200 },
  text:    { type: String, required: true, maxlength: 4000 },
}, { _id: false });

const schoolDocumentSchema = new mongoose.Schema({
  school:     { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true },
  title:      { type: String, required: true, trim: true, maxlength: 160 },
  category:   { type: String, enum: ['handbook', 'policy', 'faq', 'circular', 'other'], default: 'policy' },
  // Who may be answered from it. Empty = everyone in the school. Admins can always use every document.
  audience:   { type: [{ type: String, enum: ['student', 'parent', 'teacher', 'accountant'] }], default: [] },
  sourceType: { type: String, enum: ['text', 'pdf'], default: 'text' },
  fileName:   { type: String, default: null },
  sections:   { type: [sectionSchema], default: [] },
  version:    { type: Number, default: 1 },       // raised each time the text is replaced
  isActive:   { type: Boolean, default: true },
  uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true });

schoolDocumentSchema.index({ school: 1, isActive: 1 });

module.exports = mongoose.model('SchoolDocument', schoolDocumentSchema);
