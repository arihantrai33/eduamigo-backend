const mongoose = require('mongoose');

// Searchable chunks of text extracted from a Note's PDF. One Note produces many chunks.
// school/class/section/subject are copied from the Note so vector search can filter on them.
const noteEmbeddingSchema = new mongoose.Schema({
  noteId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Note', required: true, index: true },
  school:     { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true },
  class:      { type: String, required: true },
  section:    { type: String, default: '' }, // '' = available to all sections of the class
  subject:    { type: String, required: true },
  chunkText:  { type: String, required: true },
  chunkIndex: { type: Number, required: true },
  embedding:  { type: [Number], required: true },
  model:      { type: String },
  createdAt:  { type: Date, default: Date.now },
});

noteEmbeddingSchema.index({ school: 1, class: 1, subject: 1 });

module.exports = mongoose.model('NoteEmbedding', noteEmbeddingSchema);
