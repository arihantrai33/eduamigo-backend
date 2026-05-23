const mongoose = require('mongoose');

const noteSchema = new mongoose.Schema({
  title:      { type: String, required: true },
  subject:    { type: String, required: true },
  type:       { type: String, enum: ['Notes', 'Assignment', 'Resource', 'Question Paper'], default: 'Notes' },
  fileUrl:    { type: String },
  fileName:   { type: String },
  fileSize:   { type: String },
  uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Teacher' },
  teacherName:{ type: String },
  class:      { type: String },
  section:    { type: String },
  dueDate:    { type: Date },
  status:     { type: String, enum: ['Pending', 'Submitted', 'Urgent'], default: 'Pending' },
}, { timestamps: true });

module.exports = mongoose.model('Note', noteSchema);