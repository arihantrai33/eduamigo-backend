// School-approved study material for the tutor: the passages of the teachers' uploaded notes, assignments, resources and
// question papers that belong to the student's own school, class and section (whole-class material too).
//
// Two ways to find them, same result shape:
//   vector  Atlas Vector Search over the note embeddings (services/retrieval.js), used when the database is Atlas and a
//           Gemini key is set (LEARNING_VECTOR_SEARCH=auto, the default; "off" disables it).
//   lexical BM25 over the same stored chunk text, used otherwise (local demo, tests) and whenever the vector search fails.
// The class and section always come from the student's profile on the server, never from the request or the model.
// Returned passages are untrusted text: the tutor shows them to the model as quoted data, never as instructions.

const mongoose = require('mongoose');
const NoteEmbedding = require('../models/NoteEmbedding');
const Note = require('../models/Note');
const { terms } = require('../services/knowledge');

const MAX_CANDIDATES = 3000;
const PASSAGE_CHARS = 1100;

const vectorWanted = () => {
  const mode = String(process.env.LEARNING_VECTOR_SEARCH || 'auto').toLowerCase();
  if (mode === 'off' || !process.env.GEMINI_API_KEY) return false;
  if (mode === 'on') return true;
  return /mongodb\.net/i.test(mongoose.connection?.host || ''); // Atlas only: a local MongoDB has no $vectorSearch
};

const scope = ({ schoolId, cls, section, subject }) => {
  const q = { school: schoolId, class: String(cls), section: { $in: ['', section || ''] } };
  if (subject) q.subject = new RegExp(`^${String(subject).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
  return q;
};

async function lexical({ schoolId, cls, section, subject, query, limit }) {
  const chunks = await NoteEmbedding.find(scope({ schoolId, cls, section, subject }))
    .select('noteId subject chunkText chunkIndex').limit(MAX_CANDIDATES).lean();
  const q = [...new Set(terms(query))].slice(0, 20);
  if (!chunks.length || !q.length) return [];
  const units = chunks.map((c) => ({ c, body: terms(c.chunkText) })).filter((u) => u.body.length);
  if (!units.length) return [];
  const N = units.length;
  const avg = units.reduce((a, u) => a + u.body.length, 0) / N;
  const dfMap = new Map(q.map((t) => [t, units.filter((u) => u.body.includes(t)).length]));
  const K1 = 1.4; const B = 0.75;
  const scored = units.map((u) => {
    let score = 0;
    const matched = [];
    for (const t of q) {
      const tf = u.body.filter((x) => x === t).length;
      if (!tf) continue;
      matched.push(t);
      const n = dfMap.get(t);
      score += Math.log(1 + (N - n + 0.5) / (n + 0.5)) * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + B * (u.body.length / avg))));
    }
    return { u, score, matched };
  });
  // Relevant enough: two shared distinctive words, or one rare long word (a topic name such as "photosynthesis").
  const need = Math.min(2, q.length);
  const rare = (t) => t.length >= 6 && dfMap.get(t) <= Math.max(2, N * 0.05);
  return scored.filter((x) => x.matched.length >= need || x.matched.some(rare))
    .sort((a, b) => b.score - a.score).slice(0, limit)
    .map(({ u, score, matched }) => ({ noteId: u.c.noteId, subject: u.c.subject, chunkIndex: u.c.chunkIndex, text: u.c.chunkText, score: Math.round(score * 100) / 100, matched }));
}

async function vector({ schoolId, cls, section, subject, query, limit }) {
  const ai = require('../services/ai');
  const retrieval = require('../services/retrieval');
  const minScore = Number(process.env.REVISION_MIN_SCORE || 0.75);
  const vec = await ai.embedQuery(query);
  const rows = await retrieval.searchChunks({ school: schoolId, cls, section, subject, vector: vec, limit });
  return rows.filter((r) => r.score >= minScore).map((r) => ({ noteId: r.noteId, subject: r.subject, chunkIndex: r.chunkIndex, text: r.chunkText, score: Math.round(r.score * 100) / 100, matched: [] }));
}

// Returns { passages: [{ ref, noteId, title, type, subject, part, text, score }], method, checked, error }.
//   checked = the school's material was actually searched (false when there is no student context or the search failed).
async function findMaterials({ schoolId, cls, section, subject = null, query, limit = 4 }) {
  if (!schoolId || !cls || !String(query || '').trim()) return { passages: [], method: null, checked: false, error: null };
  let rows = [];
  let method = 'lexical';
  let error = null;
  try {
    if (vectorWanted()) {
      try { rows = await vector({ schoolId, cls, section, subject, query, limit }); method = 'vector'; } catch (err) { error = `vector: ${err.message}`; rows = []; }
    }
    if (method === 'lexical' || !rows.length) {
      const lex = await lexical({ schoolId, cls, section, subject, query, limit });
      if (method === 'lexical' || lex.length) { rows = lex; method = 'lexical'; }
    }
  } catch (err) {
    return { passages: [], method, checked: false, error: err.message };
  }
  if (!rows.length) return { passages: [], method, checked: true, error };
  // Only notes that still exist in this school are cited (a deleted note's chunks are ignored).
  const notes = await Note.find({ _id: { $in: [...new Set(rows.map((r) => String(r.noteId)))] }, school: schoolId }).select('title type subject').lean();
  const byId = new Map(notes.map((n) => [String(n._id), n]));
  const passages = rows.filter((r) => byId.has(String(r.noteId))).map((r, i) => {
    const n = byId.get(String(r.noteId));
    return {
      ref: `S${i + 1}`, noteId: String(r.noteId), title: n.title, type: n.type || 'Notes', subject: n.subject || r.subject,
      // Notes are stored as text chunks without page numbers, so a passage is located by its part of the note, not a page.
      part: (r.chunkIndex ?? 0) + 1, text: String(r.text).slice(0, PASSAGE_CHARS), score: r.score,
    };
  });
  return { passages, method, checked: true, error };
}

// The student's own notes for a "revise my notes" request: no search words are needed, so the newest notes of the class (and
// section, plus whole-class notes) are taken, one passage-sized opening part from each, up to `limit` notes. Same shape as
// findMaterials(). Only Notes-type material is revised ("revise my notes"); assignments and papers are left out.
async function recentMaterials({ schoolId, cls, section, subject = null, limit = 4 }) {
  if (!schoolId || !cls) return { passages: [], method: 'recent', checked: false, error: null };
  try {
    const q = { school: schoolId, class: String(cls), section: { $in: ['', section || ''] }, type: 'Notes' };
    if (subject) q.subject = new RegExp(`^${String(subject).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
    const notes = await Note.find(q).sort({ createdAt: -1 }).limit(limit).select('title type subject').lean();
    if (!notes.length) return { passages: [], method: 'recent', checked: true, error: null };
    const first = await NoteEmbedding.find({ school: schoolId, noteId: { $in: notes.map((n) => n._id) }, chunkIndex: 0 }).select('noteId chunkText chunkIndex').lean();
    const byNote = new Map(first.map((c) => [String(c.noteId), c]));
    const passages = notes.filter((n) => byNote.has(String(n._id))).map((n, i) => ({
      ref: `S${i + 1}`, noteId: String(n._id), title: n.title, type: n.type || 'Notes', subject: n.subject, part: 1, text: String(byNote.get(String(n._id)).chunkText).slice(0, PASSAGE_CHARS), score: null,
    }));
    return { passages, method: 'recent', checked: true, error: null };
  } catch (err) {
    return { passages: [], method: 'recent', checked: false, error: err.message };
  }
}

// Changes whenever the class's notes change (added, edited or removed): part of the tutor cache key, so a cached generic
// answer is dropped as soon as a teacher uploads notes that might now cover it.
async function notesStamp({ schoolId, cls, section }) {
  const q = { school: schoolId, class: String(cls), section: { $in: ['', section || ''] } };
  const [count, latest] = await Promise.all([Note.countDocuments(q), Note.findOne(q).sort({ updatedAt: -1 }).select('updatedAt').lean()]);
  return `${count}:${latest?.updatedAt ? new Date(latest.updatedAt).getTime() : 0}`;
}

// Subjects that have material for this class (for the subject picker).
async function subjectsWithMaterial({ schoolId, cls, section }) {
  return Note.distinct('subject', { school: schoolId, class: String(cls), section: { $in: ['', section || ''] } });
}

module.exports = { findMaterials, recentMaterials, notesStamp, subjectsWithMaterial };
