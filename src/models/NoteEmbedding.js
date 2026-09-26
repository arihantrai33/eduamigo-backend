const mongoose = require('mongoose');

// This stores small searchable "chunks" of text extracted from a Note's PDF.
// One Note (PDF) will produce MANY NoteEmbedding documents (one per chunk).
const noteEmbeddingSchema = new mongoose.Schema({
  noteId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Note', required: true },
  school:     { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true }, // mandatory - multi-tenant safety
  class:      { type: String, required: true },
  section:    { type: String },
  subject:    { type: String, required: true },

  chunkText:  { type: String, required: true },   // the actual extracted text piece
  chunkIndex: { type: Number, required: true },    // order of this chunk within the note
  embedding:  { type: [Number], required: true },  // vector representation of chunkText

  createdAt:  { type: Date, default: Date.now },
});

// Speeds up filtering by school+class+subject before vector search runs
noteEmbeddingSchema.index({ school: 1, class: 1, subject: 1 });

module.exports = mongoose.model('NoteEmbedding', noteEmbeddingSchema);