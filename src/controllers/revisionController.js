const { GoogleGenerativeAI } = require('@google/generative-ai');
const NoteEmbedding = require('../models/NoteEmbedding');
const Note = require('../models/Note');
const Student = require('../models/Student');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

async function embedQuery(text) {
  const model = genAI.getGenerativeModel({ model: 'gemini-embedding-001' });
  const result = await model.embedContent(text);
  return result.embedding.values;
}

function buildSystemPrompt() {
  return `You are a friendly, patient study buddy helping a school student revise for exams over chat.

LANGUAGE RULE (very important): Reply in the SAME language and style the student used to ask their question.
- If they wrote in Hindi (Devanagari), reply in Hindi.
- If they wrote in Hinglish (Hindi words typed in Roman/English letters, e.g. "mujhe revision karwao"), reply in that same Hinglish style.
- If they wrote in English, reply in English.
Never switch to a different language than the one the student used. Keep the tone casual and conversational, like a helpful senior/tutor chatting with them - not a textbook.

HOW TO ANSWER:
- Do NOT copy sentences directly from the notes/context. Explain things in your own simple words, like you're teaching it out loud in a conversation.
- Pay attention to what the student is actually asking:
  - If they ask for a full chapter/topic revision (e.g. "MS Excel chapter revise karwao"), give a well-organized, easy-to-scan summary of the key concepts in your own words - not a copy of the notes.
  - If they ask a specific/narrow question, answer just that, concisely - don't dump the whole chapter.
- Use short examples or simple analogies where they help understanding.
- Keep it exam-friendly: clear, simple, well-structured (short paragraphs or bullet points), no unnecessary jargon.
- Remember what has already been discussed earlier in this conversation (e.g. which chapter/topic the student is revising). If the student refers to "this chapter" or "isme se" etc., use the conversation history to figure out what they mean - don't ask them to repeat it unless the history genuinely has no such reference.`;
}

function buildUserTurn(question, chunks) {
  const hasContext = chunks.length > 0;
  const context = chunks
    .map((c, i) => `[Source ${i + 1} - ${c.noteTitle}]\n${c.chunkText}`)
    .join('\n\n');

  return `${hasContext ? `CONTEXT FROM THE STUDENT'S UPLOADED NOTES (use this as your source of facts, but explain it in your own words - do not paste it verbatim):
${context}
` : `No matching content was found in the student's uploaded notes for this question.
If the conversation history doesn't already cover this, politely let the student know (in their language/style) that you couldn't find this in their uploaded notes, and suggest they rephrase or ask their teacher to upload notes on this topic. Do not make up an answer.
`}
Student's question: ${question}`;
}

const askRevisionQuestion = async (req, res) => {
  try {
    const { question, subject, class: classParam, history } = req.body;

    if (!question || !question.trim()) {
      return res.status(400).json({ message: 'Question is required' });
    }

    const conversationHistory = Array.isArray(history) ? history : [];

    const school = req.user.school?._id || req.user.school;
    let studentClass = classParam;

    if (!studentClass && req.user.role === 'student' && req.user.profileId) {
      const studentProfile = await Student.findById(req.user.profileId).select('class');
      studentClass = studentProfile?.class;
    }

    if (!school || !studentClass) {
      return res.status(400).json({ message: 'Could not determine school/class for this user' });
    }

    const queryEmbedding = await embedQuery(question);

    const filter = {
      school: { $eq: school },
      class: { $eq: String(studentClass) },
    };
    if (subject) {
      filter.subject = { $eq: subject };
    }

    const results = await NoteEmbedding.aggregate([
      {
        $vectorSearch: {
          index: 'vector_index',
          path: 'embedding',
          queryVector: queryEmbedding,
          numCandidates: 100,
          limit: 5,
          filter,
        },
      },
      {
        $project: {
          chunkText: 1,
          noteId: 1,
          subject: 1,
          score: { $meta: 'vectorSearchScore' },
        },
      },
    ]);

    const RELEVANCE_THRESHOLD = 0.80;
    const relevantResults = results.filter(r => r.score >= RELEVANCE_THRESHOLD);

    let chunks = [];
    let sources = [];

    if (relevantResults.length) {
      const noteIds = [...new Set(relevantResults.map(r => r.noteId.toString()))];
      const notes = await Note.find({ _id: { $in: noteIds } }).select('title');
      const titleMap = Object.fromEntries(notes.map(n => [n._id.toString(), n.title]));

      chunks = relevantResults.map(r => ({
        chunkText: r.chunkText,
        noteTitle: titleMap[r.noteId.toString()] || 'Unknown note',
        score: r.score,
      }));
      sources = [...new Set(chunks.map(c => c.noteTitle))];
    }

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    if (res.flushHeaders) res.flushHeaders();

    res.write(JSON.stringify({ sources }) + '\n');

    const model = genAI.getGenerativeModel({
      model: 'gemini-3.6-flash',
      systemInstruction: buildSystemPrompt(),
    });

    const geminiHistory = conversationHistory
      .filter(turn => turn && turn.text && turn.text.trim())
      .map(turn => ({
        role: turn.role === 'model' ? 'model' : 'user',
        parts: [{ text: turn.text }],
      }));

    while (geminiHistory.length && geminiHistory[0].role !== 'user') {
      geminiHistory.shift();
    }

    const chat = model.startChat({ history: geminiHistory });
    const userTurn = buildUserTurn(question, chunks);

    const streamResult = await chat.sendMessageStream(userTurn);
    for await (const chunk of streamResult.stream) {
      const text = chunk.text();
      if (text) res.write(text);
    }

    res.end();
  } catch (err) {
    console.error('Revision chat error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ message: 'Something went wrong answering your question' });
    } else {
      res.end();
    }
  }
};

module.exports = { askRevisionQuestion };