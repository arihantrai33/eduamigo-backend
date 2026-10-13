// Thin wrapper around Gemini so the rest of the code (and the tests) never talk to the SDK directly.
const { GoogleGenerativeAI, TaskType } = require('@google/generative-ai');

const EMBEDDING_MODEL = process.env.GEMINI_EMBEDDING_MODEL || 'gemini-embedding-001';
const CHAT_MODEL = process.env.GEMINI_CHAT_MODEL || 'gemini-3.6-flash';
const aiUsage = require('./aiUsage');

// Embeddings and the old revision chat go straight to Gemini (not through assistant/llm.js), so they record their own usage.
// Gemini does not return token counts for embeddings, so those figures are estimates (flagged as such in the ledger).
function meter(feature, model, input, output, started, ok = true) {
  aiUsage.record({ feature, provider: 'gemini', model, inputTokens: input, outputTokens: output, estimated: true, ms: Date.now() - started, ok });
}

let client;
function gemini() {
  if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not configured');
  client = client || new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  return client;
}

async function embedQuery(text) {
  const started = Date.now();
  const model = gemini().getGenerativeModel({ model: EMBEDDING_MODEL });
  try {
    const result = await model.embedContent({ content: { role: 'user', parts: [{ text }] }, taskType: TaskType.RETRIEVAL_QUERY });
    meter('embeddings', EMBEDDING_MODEL, aiUsage.roughTokens(text), 0, started);
    return result.embedding.values;
  } catch (err) {
    meter('embeddings', EMBEDDING_MODEL, 0, 0, started, false);
    throw err;
  }
}

// Embeds many chunks in batches (far fewer API calls than one request per chunk).
async function embedDocuments(texts, title) {
  const model = gemini().getGenerativeModel({ model: EMBEDDING_MODEL });
  const out = [];
  for (let i = 0; i < texts.length; i += 50) {
    const batch = texts.slice(i, i + 50);
    const started = Date.now();
    let result;
    try {
      result = await model.batchEmbedContents({
        requests: batch.map((text) => ({
          content: { role: 'user', parts: [{ text }] },
          taskType: TaskType.RETRIEVAL_DOCUMENT,
          ...(title ? { title } : {}),
        })),
      });
    } catch (err) {
      meter('embeddings', EMBEDDING_MODEL, 0, 0, started, false);
      throw err;
    }
    meter('embeddings', EMBEDDING_MODEL, aiUsage.roughTokens(batch.join('')), 0, started);
    out.push(...result.embeddings.map((e) => e.values));
  }
  return out;
}

// Returns an async iterable of text pieces.
async function streamChat({ systemInstruction, history, message }) {
  const model = gemini().getGenerativeModel({ model: CHAT_MODEL, systemInstruction });
  const chat = model.startChat({ history });
  const started = Date.now();
  const result = await chat.sendMessageStream(message);
  const inputText = `${systemInstruction || ''}${(history || []).map((h) => h.parts?.[0]?.text || '').join('')}${message}`;
  return (async function* pieces() {
    let all = '';
    let ok = true;
    try {
      for await (const chunk of result.stream) {
        const text = chunk.text();
        if (text) { all += text; yield text; }
      }
    } catch (err) { ok = false; throw err; } finally {
      let usage = null;
      try { usage = (await result.response).usageMetadata; } catch { /* optional */ }
      aiUsage.record({
        feature: 'revision_legacy', provider: 'gemini', model: CHAT_MODEL, ok, ms: Date.now() - started, estimated: !usage,
        inputTokens: usage?.promptTokenCount ?? aiUsage.roughTokens(inputText), outputTokens: usage?.candidatesTokenCount ?? aiUsage.roughTokens(all),
      });
    }
  }());
}

module.exports = { embedQuery, embedDocuments, streamChat, EMBEDDING_MODEL, CHAT_MODEL };
