// EduAmigo Learning AI for students: AI Tutor / Guided Learning chat, conversation history, and the context the app needs
// (subjects with school material, upcoming exams from the school's schedule). Practice & Assessment, the Revision Planner
// and Learning Progress are in practiceController.js.
//
// Every route is for the signed-in student only; school, class and section come from the student's profile on the server.

const LearningConversation = require('../models/LearningConversation');
const { HttpError, asyncHandler, assertId } = require('../utils/http');
const { studentForUser } = require('../services/directory');
const { usageThisMonth, recordUsage } = require('../services/subscription');
const { teach } = require('../learning/tutor');
const { subjectsWithMaterial } = require('../learning/materials');
const { upcomingExams } = require('../learning/planner');
const aiUsage = require('../services/aiUsage');
const llm = require('../assistant/llm');
const speech = require('../learning/speech');

const MAX_MESSAGE = 2000;

async function ownStudent(req) {
  const student = await studentForUser(req.user);
  if (!student) throw new HttpError(404, 'Student profile not found');
  return student;
}

// The school's monthly AI allowance (shared with Ask and revision). Counted only when a model answer is attempted.
async function assertAllowance(req) {
  const allowance = req.entitlements?.limits?.aiQuestionsPerMonth;
  if (allowance != null && (await usageThisMonth(req.schoolId, 'ai_questions')) >= allowance) {
    throw new HttpError(429, 'Your school has used this month\'s AI questions. The limit resets on the 1st.', { code: 'PLAN_LIMIT' });
  }
}

const titleFrom = (text) => {
  const t = String(text).replace(/\s+/g, ' ').trim();
  return t.length > 60 ? `${t.slice(0, 57)}…` : t;
};

// POST /api/learning/chat  { message, conversationId?, subject?, mode?: 'tutor'|'guided', voice?: bool }
// Response: NDJSON (one JSON event per line): meta, delta..., final | error. See learning/tutor.js.
exports.chat = asyncHandler(async (req, res) => {
  const message = String(req.body?.message || '').trim();
  if (!message) throw new HttpError(400, 'Type or say a question first');
  if (message.length > MAX_MESSAGE) throw new HttpError(400, `Please keep your question under ${MAX_MESSAGE} characters`);
  const mode = req.body?.mode === 'guided' ? 'guided' : 'tutor';
  const subject = req.body?.subject ? String(req.body.subject).trim().slice(0, 40) : null;
  const voice = req.body?.voice === true;

  const student = await ownStudent(req);
  await assertAllowance(req);
  // The school's AI limits (budget, tokens, tutor quota) and one answer at a time per student: refused before anything is paid for.
  await aiUsage.assertAllowed({ schoolId: req.schoolId, entitlements: req.entitlements, group: 'tutor' });
  const release = aiUsage.acquire(req.user._id, 'tutor');
  try {
    let conv = null;
    if (req.body?.conversationId) {
      assertId(req.body.conversationId);
      conv = await LearningConversation.findOne({ _id: req.body.conversationId, school: req.schoolId, user: req.user._id });
      if (!conv) throw new HttpError(404, 'This conversation was not found. Start a new chat.');
    } else {
      conv = new LearningConversation({ school: req.schoolId, user: req.user._id, student: student._id, title: titleFrom(message), subject, mode });
    }
    const history = conv.turns.map((t) => ({ role: t.role, text: t.text }));
    const subjects = await subjectsWithMaterial({ schoolId: req.schoolId, cls: student.class, section: student.section });

    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    const write = (event) => { if (!res.writableEnded && !controller.signal.aborted) res.write(`${JSON.stringify(event)}\n`); };

    // Counted as one AI question only when the model was asked: fixed replies and cached answers are free.
    let counted = false;
    const result = await aiUsage.within({ school: req.schoolId, user: req.user._id, feature: 'tutor', voice }, () => teach({
      role: 'student', student, schoolId: req.schoolId, message, history, mode, subject, subjects, spoken: voice, signal: controller.signal,
      topic: conv.topic?.topic ? { subject: conv.topic.subject, topic: conv.topic.topic } : null, conversationLanguage: conv.language,
      emit: (event) => {
        if (event.type === 'meta') { write({ ...event, conversationId: String(conv._id) }); return; }
        if (event.type === 'delta' && !event.free && !counted) { counted = true; recordUsage(req.schoolId, 'ai_questions').catch(() => {}); }
        if (event.type === 'final') return; // written after saving, below
        write(event);
      },
    }));

    // The student's question is kept even when no answer came; an answer is kept only when it finished.
    conv.turns.push({ role: 'user', text: message.slice(0, 8000), meta: voice ? { voice: true } : {} });
    if (result.type === 'final') {
      conv.turns.push({ role: 'assistant', text: result.text.slice(0, 8000) || '…', meta: { confidence: result.confidence, sources: result.used, checks: result.checks, diagrams: result.diagrams } });
      if (result.topic?.topic) conv.topic = result.topic; // what "this" means in the next message
    }
    if (conv.turns.length > LearningConversation.MAX_TURNS) conv.turns = conv.turns.slice(-LearningConversation.MAX_TURNS);
    conv.mode = mode;
    if (subject) conv.subject = subject;
    if (result.language) conv.language = result.language;
    try { await conv.save(); } catch { /* the answer was already given; history is best effort */ }
    if (result.type === 'final') write({ ...result, conversationId: String(conv._id) });
    res.end();
  } finally {
    release();
  }
});

// GET /api/learning/conversations
exports.listConversations = asyncHandler(async (req, res) => {
  const list = await LearningConversation.find({ school: req.schoolId, user: req.user._id }).sort({ updatedAt: -1 }).limit(30)
    .select('title subject mode updatedAt turns').lean();
  res.json({ success: true, data: list.map((c) => ({ _id: c._id, title: c.title, subject: c.subject, mode: c.mode, updatedAt: c.updatedAt, turns: c.turns.length })) });
});

// GET /api/learning/conversations/:id
exports.getConversation = asyncHandler(async (req, res) => {
  assertId(req.params.id);
  const conv = await LearningConversation.findOne({ _id: req.params.id, school: req.schoolId, user: req.user._id }).lean();
  if (!conv) throw new HttpError(404, 'Conversation not found');
  res.json({ success: true, data: conv });
});

// DELETE /api/learning/conversations/:id   and   DELETE /api/learning/conversations (all of the student's)
exports.deleteConversation = asyncHandler(async (req, res) => {
  assertId(req.params.id);
  const r = await LearningConversation.deleteOne({ _id: req.params.id, school: req.schoolId, user: req.user._id });
  if (!r.deletedCount) throw new HttpError(404, 'Conversation not found');
  res.json({ success: true, message: 'Conversation deleted' });
});
exports.clearConversations = asyncHandler(async (req, res) => {
  const r = await LearningConversation.deleteMany({ school: req.schoolId, user: req.user._id });
  res.json({ success: true, message: `${r.deletedCount} conversation${r.deletedCount === 1 ? '' : 's'} deleted`, data: { deleted: r.deletedCount } });
});

// GET /api/learning/context  -> what the Learning AI screen shows before the first question
exports.context = asyncHandler(async (req, res) => {
  const student = await ownStudent(req);
  const [subjects, exams] = await Promise.all([
    subjectsWithMaterial({ schoolId: req.schoolId, cls: student.class, section: student.section }),
    upcomingExams({ schoolId: req.schoolId, cls: student.class, section: student.section }),
  ]);
  res.json({
    success: true,
    data: {
      class: student.class, section: student.section,
      subjects: subjects.sort(), exams,
      capabilities: {
        // Web research needs a search provider; none is configured, so the tutor never claims to have searched the web.
        webResearch: false,
        ai: { available: llm.available(), reason: llm.unavailableReason() },
        // A natural (neural) spoken voice for answers; when false the app speaks with the device's own voice.
        voice: { natural: speech.available() },
        historyDays: Number(process.env.LEARNING_HISTORY_DAYS || 180),
      },
    },
  });
});

// One short piece of the tutor's answer, spoken in a natural voice (audio/wav). The text is what the screen already shows; it
// counts against the school's AI budget like any other model call. A 503 tells the app to use the device's voice instead.
exports.speak = asyncHandler(async (req, res) => {
  const text = String(req.body?.text || '').replace(/\s+/g, ' ').trim();
  if (!text) throw new HttpError(400, 'There is nothing to say');
  if (text.length > speech.MAX_CHARS) throw new HttpError(400, `Send at most ${speech.MAX_CHARS} characters at a time`);
  if (!speech.available()) throw Object.assign(new HttpError(503, 'The natural voice is not switched on for this server.', { code: 'VOICE_OFF' }), { expose: true });
  await aiUsage.assertAllowed({ schoolId: req.schoolId, entitlements: req.entitlements, group: null });
  const out = await aiUsage.within({ school: req.schoolId, user: req.user._id, feature: 'voice_out', voice: true }, () => speech.synthesize({ text }));
  res.set({ 'Content-Type': out.mime, 'Cache-Control': 'private, max-age=600', 'X-Voice-Cached': out.cached ? '1' : '0' }).send(out.audio);
});
