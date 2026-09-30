const mongoose = require('mongoose');

const bookSchema = new mongoose.Schema({
  school:      { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true },
  title:       { type: String, required: true, trim: true },
  author:      { type: String, trim: true },
  isbn:        { type: String, trim: true },
  category:    { type: String, enum: ['Textbook', 'Fiction', 'Biography', 'Reference', 'Science', 'History', 'Other'], default: 'Other' },
  totalCopies: { type: Number, required: true, default: 1, min: 0 },
  available:   { type: Number, required: true, default: 1, min: 0 },
  issued:      { type: Number, default: 0, min: 0 },
  publisher:   { type: String },
  year:        { type: Number },
  addedBy:     { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

bookSchema.index({ school: 1, title: 1 });

module.exports = mongoose.model('Library', bookSchema);
