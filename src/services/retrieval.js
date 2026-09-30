// Vector search over note chunks (MongoDB Atlas Vector Search).
// The Atlas index "vector_index" on collection "noteembeddings" must declare
// `embedding` as the vector field and school, class, section, subject as filter fields
// (see docs/AI_REVISION.md).
const NoteEmbedding = require('../models/NoteEmbedding');

async function searchChunks({ school, cls, section, subject, vector, limit = 6 }) {
  const filter = {
    school: { $eq: school },
    class: { $eq: String(cls) },
    section: { $in: [section || '', ''] },
  };
  if (subject) filter.subject = { $eq: subject };

  return NoteEmbedding.aggregate([
    {
      $vectorSearch: {
        index: process.env.VECTOR_INDEX_NAME || 'vector_index',
        path: 'embedding',
        queryVector: vector,
        numCandidates: 150,
        limit,
        filter,
      },
    },
    { $project: { chunkText: 1, noteId: 1, subject: 1, chunkIndex: 1, score: { $meta: 'vectorSearchScore' } } },
  ]);
}

module.exports = { searchChunks };
