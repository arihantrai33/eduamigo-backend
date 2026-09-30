// Thin wrapper around Gemini so the rest of the code (and the tests) never talk to the SDK directly.
const { GoogleGenerativeAI, TaskType } = require('@google/generative-ai');

const EMBEDDING_MODEL = process.env.GEMINI_EMBEDDING_MODEL || 'gemini-embedding-001';
const CHAT_MODEL = process.env.GEMINI_CHAT_MODEL || 'gemini-3.6-flash';

let client;
function gemini() {
  if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not configured');
  client = client || new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  return client;
}

async function embedQuery(text) {
  const model = gemini().getGenerativeModel({ model: EMBEDDING_MODEL });
  const result = await model.embedContent({ content: { role: 'user', parts: [{ text }] }, taskType: TaskType.RETRIEVAL_QUERY });
  return result.embedding.values;
}

// Embeds many chunks in batches (far fewer API calls than one request per chunk).
async function embedDocuments(texts, title) {
  const model = gemini().getGenerativeModel({ model: EMBEDDING_MODEL });
  const out = [];
  for (let i = 0; i < texts.length; i += 50) {
    const batch = texts.slice(i, i + 50);
    const result = await model.batchEmbedContents({
      requests: batch.map((text) => ({
        content: { role: 'user', parts: [{ text }] },
        taskType: TaskType.RETRIEVAL_DOCUMENT,
        ...(title ? { title } : {}),
      })),
    });
    out.push(...result.embeddings.map((e) => e.values));
  }
  return out;
}

// Returns an async iterable of text pieces.
async function streamChat({ systemInstruction, history, message }) {
  const model = gemini().getGenerativeModel({ model: CHAT_MODEL, systemInstruction });
  const chat = model.startChat({ history });
  const result = await chat.sendMessageStream(message);
  return (async function* pieces() {
    for await (const chunk of result.stream) {
      const text = chunk.text();
      if (text) yield text;
    }
  }());
}

module.exports = { embedQuery, embedDocuments, streamChat, EMBEDDING_MODEL, CHAT_MODEL };
