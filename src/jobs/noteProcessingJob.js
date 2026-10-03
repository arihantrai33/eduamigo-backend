const axios = require('axios');
const cron = require('node-cron');

const Note = require('../models/Note');
const NoteEmbedding = require('../models/NoteEmbedding');
const ai = require('../services/ai');
const { schoolIdsWithFeature } = require('../services/subscription');

const MAX_ATTEMPTS = 3;
const LOCK_MINUTES = 15;
const MAX_PDF_BYTES = 15 * 1024 * 1024;

// Splits text into ~chunkSize character pieces on paragraph/sentence boundaries,
// with a small overlap so an idea that spans two chunks is still retrievable.
function chunkText(text, chunkSize = 1200, overlap = 150) {
  const clean = String(text).replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  const pieces = clean.split(/(?<=[.!?।])\s+|\n\n/).map((p) => p.trim()).filter(Boolean);
  const chunks = [];
  let current = '';
  for (const piece of pieces) {
    if (piece.length > chunkSize) {
      if (current) { chunks.push(current); current = ''; }
      for (let i = 0; i < piece.length; i += chunkSize - overlap) chunks.push(piece.slice(i, i + chunkSize));
      continue;
    }
    if ((current + ' ' + piece).length > chunkSize && current) {
      chunks.push(current);
      current = current.slice(-overlap).replace(/^\S*\s/, '') + ' ' + piece;
    } else {
      current = current ? `${current} ${piece}` : piece;
    }
  }
  if (current) chunks.push(current);
  return chunks.map((c) => c.trim()).filter((c) => c.length > 30);
}

async function extractPdfText(url) {
  const { PDFParse } = require('pdf-parse');
  const response = await axios.get(url, { responseType: 'arraybuffer', timeout: 60000, maxContentLength: MAX_PDF_BYTES });
  const parser = new PDFParse({ data: Buffer.from(response.data) });
  try {
    const parsed = await parser.getText();
    return parsed.text || '';
  } finally {
    await parser.destroy();
  }
}

// Atomically claims one note so two server instances (or overlapping runs) never process the same note.
// Only notes of schools with the AI Revision feature are processed (embedding costs money). Notes of
// other schools stay pending and are picked up automatically if the school adds the feature later.
async function claimNextNote(schools) {
  const now = new Date();
  return Note.findOneAndUpdate(
    {
      school: { $in: schools },
      type: 'Notes',
      fileUrl: { $ne: null },
      $or: [
        { 'processing.status': { $in: ['pending', null] } },
        { 'processing.status': { $exists: false } },
        { 'processing.status': 'failed', 'processing.attempts': { $lt: MAX_ATTEMPTS } },
        { 'processing.status': 'processing', 'processing.lockedUntil': { $lt: now } },
      ],
    },
    {
      $set: { 'processing.status': 'processing', 'processing.lockedUntil': new Date(now.getTime() + LOCK_MINUTES * 60000) },
      $inc: { 'processing.attempts': 1 },
    },
    { sort: { createdAt: 1 }, returnDocument: 'after' },
  );
}

async function processNote(note, deps = {}) {
  const extract = deps.extractPdfText || extractPdfText;
  const embed = deps.embedDocuments || ai.embedDocuments;
  try {
    if (!note.school || !note.class) throw Object.assign(new Error('Note is missing school or class'), { permanent: true });

    const rawText = await extract(note.fileUrl);
    if (!rawText || rawText.trim().length < 50) {
      await Note.updateOne({ _id: note._id }, { $set: {
        'processing.status': 'skipped', 'processing.error': 'No readable text found (scanned or image-only PDF)',
        'processing.lockedUntil': null, 'processing.processedAt': new Date(), 'processing.chunks': 0,
      } });
      return { status: 'skipped' };
    }

    const chunks = chunkText(rawText);
    const vectors = await embed(chunks.map((c) => `${note.subject}: ${c}`), note.title);
    if (vectors.length !== chunks.length) throw new Error('Embedding count mismatch');

    // Replace any partial results from an earlier failed attempt, then insert everything at once.
    await NoteEmbedding.deleteMany({ noteId: note._id });
    await NoteEmbedding.insertMany(chunks.map((chunkTextValue, i) => ({
      noteId: note._id, school: note.school, class: note.class, section: note.section || '',
      subject: note.subject, chunkText: chunkTextValue, chunkIndex: i, embedding: vectors[i], model: ai.EMBEDDING_MODEL,
    })));

    await Note.updateOne({ _id: note._id }, { $set: {
      'processing.status': 'ready', 'processing.chunks': chunks.length, 'processing.error': null,
      'processing.lockedUntil': null, 'processing.processedAt': new Date(),
    } });
    return { status: 'ready', chunks: chunks.length };
  } catch (err) {
    await NoteEmbedding.deleteMany({ noteId: note._id });
    await Note.updateOne({ _id: note._id }, { $set: {
      'processing.status': 'failed', 'processing.error': String(err.message).slice(0, 500), 'processing.lockedUntil': null,
      ...(err.permanent ? { 'processing.attempts': MAX_ATTEMPTS } : {}),
    } });
    console.error(`Note ${note._id} processing failed:`, err.message);
    return { status: 'failed', error: err.message };
  }
}

let running = false;
async function runPendingNotes({ maxNotes = 20, deps } = {}) {
  if (running) return { skipped: true };
  running = true;
  const results = [];
  try {
    const schools = await schoolIdsWithFeature('ai_revision');
    for (let i = 0; schools.length && i < maxNotes; i += 1) {
      const note = await claimNextNote(schools);
      if (!note) break;
      results.push(await processNote(note, deps));
    }
  } finally {
    running = false;
  }
  return { processed: results.length, results };
}

function startNoteProcessingJob() {
  cron.schedule('*/5 * * * *', () => {
    runPendingNotes().catch((err) => console.error('noteProcessingJob error:', err.message));
  });
  console.log('Note processing job scheduled (every 5 minutes)');
}

module.exports = startNoteProcessingJob;
module.exports.runPendingNotes = runPendingNotes;
module.exports.processNote = processNote;
module.exports.chunkText = chunkText;
