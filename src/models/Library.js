const mongoose = require('mongoose');
const bookSchema = new mongoose.Schema({
  title:       { type: String, required: true },
  author:      { type: String },
  isbn:        { type: String },
  category:    { type: String, enum: ['Textbook', 'Fiction', 'Biography', 'Reference', 'Science', 'History', 'Other'], default: 'Other' },
  totalCopies: { type: Number, required: true, default: 1 },
  available:   { type: Number, required: true, default: 1 },
  issued:      { type: Number, default: 0 },
  publisher:   { type: String },
  year:        { type: Number },
  addedBy:     { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });
module.exports = mongoose.model('Library', bookSchema);
