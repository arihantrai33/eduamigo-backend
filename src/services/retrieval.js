// Vector search over note chunks (MongoDB Atlas Vector Search).
// The Atlas index "vector_index" on collection "noteembeddings" must declare
// `embedding` as the vector field and school, class, section, subject as filter fields
// (see docs/AI_REVISION.md).
const NoteEmbedding = require('../models/NoteEmbedding');

let sectionFilterMissing = false;

function isMissingFilterError(err, field) {
  return new RegExp(`Path '${field}' needs to be indexed as filter`).test(String(err?.message || err?.errmsg || ''));
}

function pipeline({ vector, limit, filter }) {
  return [
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
    { $project: { chunkText: 1, noteId: 1, subject: 1, section: 1, chunkIndex: 1, score: { $meta: 'vectorSearchScore' } } },
  ];
}

async function searchChunks({ school, cls, section, subject, vector, limit = 6 }) {
  const base = { school: { $eq: school }, class: { $eq: String(cls) } };
  if (subject) base.subject = { $eq: subject };
  const allowedSections = [section || '', ''];

  if (!sectionFilterMissing) {
    try {
      return await NoteEmbedding.aggregate(pipeline({ vector, limit, filter: { ...base, section: { $in: allowedSections } } }));
    } catch (err) {
      if (!isMissingFilterError(err, 'section')) throw err;
      sectionFilterMissing = true;
      console.warn('Atlas vector index has no "section" filter field. Falling back to filtering sections in the app; '
        + 'update the index as described in docs/AI_REVISION.md.');
    }
  }

  // Fallback while the index is outdated: search the class, then keep only this section and whole-class notes.
  const rows = await NoteEmbedding.aggregate(pipeline({ vector, limit: limit * 4, filter: base }));
  return rows.filter((r) => allowedSections.includes(r.section || '')).slice(0, limit);
}

function resetIndexState() { sectionFilterMissing = false; }

module.exports = { searchChunks, resetIndexState };
