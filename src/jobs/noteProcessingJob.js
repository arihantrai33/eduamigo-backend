const axios = require('axios');
const { PDFParse } = require('pdf-parse');
const cron = require('node-cron');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const Note = require('../models/Note');
const NoteEmbedding = require('../models/NoteEmbedding');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ---- STEP A: split extracted text into overlapping chunks ----
function chunkText(text, chunkSize = 1200, overlap = 150) {
  // chunkSize/overlap are in characters here (simple + good enough to start).
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + chunkSize, text.length);
    chunks.push(text.slice(start, end).trim());
    start += chunkSize - overlap;
  }
  return chunks.filter(c => c.length > 30); // drop tiny/empty leftover chunks
}

// ---- STEP B: generate an embedding for one chunk using Gemini ----
async function generateEmbedding(text) {
  const model = genAI.getGenerativeModel({ model: 'gemini-embedding-001' });
  const result = await model.embedContent(text);
  return result.embedding.values;
}

// ---- STEP C: process a single note end-to-end ----
async function processNote(note) {
  let parser;
  try {
    console.log(`Processing note: ${note.title} (${note._id})`);

    // 1. Download the PDF from Cloudinary
    const response = await axios.get(note.fileUrl, { responseType: 'arraybuffer' });
    const pdfBuffer = Buffer.from(response.data);

    // 2. Extract raw text (pdf-parse v2 API — uses PDFParse class)
    parser = new PDFParse({ data: pdfBuffer });
    const parsed = await parser.getText();
    const rawText = parsed.text;

    if (!rawText || rawText.trim().length < 50) {
      console.warn(`Note ${note._id} produced very little text — might be a scanned/image PDF.`);
      return;
    }

    // 3. Split into chunks
    const chunks = chunkText(rawText);

    // 4. Generate embeddings + save, one chunk at a time
    for (let i = 0; i < chunks.length; i++) {
      const embedding = await generateEmbedding(chunks[i]);

      await NoteEmbedding.create({
        noteId: note._id,
        school: note.school,       // make sure Note.js actually has a `school` field — add it if missing
        class: note.class,
        section: note.section,
        subject: note.subject,
        chunkText: chunks[i],
        chunkIndex: i,
        embedding,
      });
    }

    console.log(`Done: ${chunks.length} chunks saved for note ${note._id}`);
  } catch (err) {
    console.error(`Failed to process note ${note._id}:`, err.message);
    // TODO: mark note as "processingFailed" so an admin can see and retry
  } finally {
    if (parser) {
      await parser.destroy(); // free memory used by the PDF parser
    }
  }
}

// ---- STEP D: find notes that haven't been processed yet, and run them ----
async function runPendingNotes() {
  // Only picks up notes of type "Notes" (not Assignment/Question Paper) that
  // don't already have embeddings.
  const processedNoteIds = await NoteEmbedding.distinct('noteId');
  const pendingNotes = await Note.find({
    type: 'Notes',
    _id: { $nin: processedNoteIds },
  });

  console.log(`Found ${pendingNotes.length} note(s) waiting to be processed`);
  for (const note of pendingNotes) {
    await processNote(note);
  }
}

// ---- STEP E: schedule this to run automatically ----
function startNoteProcessingJob() {
  // Runs every 5 minutes — adjust as needed
  cron.schedule('*/5 * * * *', () => {
    runPendingNotes().catch(err => console.error('noteProcessingJob error:', err.message));
  });
  console.log('📄 Note processing job scheduled (every 5 min)');
}

module.exports = startNoteProcessingJob;