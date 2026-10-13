// Practice & Assessment, Revision Planner and Learning Progress (students). See learning/practice.js and learning/planner.js.
const PracticeSession = require('../models/PracticeSession');
const RevisionPlan = require('../models/RevisionPlan');
const LearningConversation = require('../models/LearningConversation');
const { HttpError, asyncHandler, assertId } = require('../utils/http');
const { studentForUser } = require('../services/directory');
const { usageThisMonth, recordUsage } = require('../services/subscription');
const practice = require('../learning/practice');
const { buildPlan, practiceAccuracy } = require('../learning/planner');
const { formatDay, toDayKey } = require('../utils/dates');

async function ownStudent(req) {
  const student = await studentForUser(req.user);
  if (!student) throw new HttpError(404, 'Student profile not found');
  return student;
}
async function ownSession(req) {
  assertId(req.params.id);
  const s = await PracticeSession.findOne({ _id: req.params.id, school: req.schoolId, user: req.user._id });
  if (!s) throw new HttpError(404, 'Practice set not found');
  return s;
}

// POST /api/learning/practice  { subject, topic?, count?, difficulty?, formats?, focus?: 'weak' }
exports.createPractice = asyncHandler(async (req, res) => {
  const student = await ownStudent(req);
  const allowance = req.entitlements?.limits?.aiQuestionsPerMonth;
  if (allowance != null && (await usageThisMonth(req.schoolId, 'ai_questions')) >= allowance) {
    throw new HttpError(429, 'Your school has used this month\'s AI questions. The limit resets on the 1st.', { code: 'PLAN_LIMIT' });
  }
  await recordUsage(req.schoolId, 'ai_questions');
  const session = await practice.createSet({ schoolId: req.schoolId, user: req.user, student, input: req.body || {} });
  res.status(201).json({ success: true, data: practice.publicSession(session) });
});

// GET /api/learning/practice   (recent sets)   GET /api/learning/practice/:id
exports.listPractice = asyncHandler(async (req, res) => {
  const list = await PracticeSession.find({ school: req.schoolId, user: req.user._id }).sort({ createdAt: -1 }).limit(20);
  res.json({ success: true, data: list.map((s) => ({ _id: s._id, subject: s.subject, topic: s.topic, difficulty: s.difficulty, createdAt: s.createdAt, summary: practice.summarize(s) })) });
});
exports.getPractice = asyncHandler(async (req, res) => {
  res.json({ success: true, data: practice.publicSession(await ownSession(req)) });
});

// POST /api/learning/practice/:id/answer  { questionId, answer }
exports.answer = asyncHandler(async (req, res) => {
  const session = await ownSession(req);
  const result = await practice.markAnswer({ session, questionId: String(req.body?.questionId || ''), answer: req.body?.answer });
  res.json({ success: true, data: { ...result, summary: practice.summarize(session) } });
});

// POST /api/learning/practice/:id/reveal  { questionId }
exports.reveal = asyncHandler(async (req, res) => {
  const session = await ownSession(req);
  const out = await practice.reveal({ session, questionId: String(req.body?.questionId || '') });
  res.json({ success: true, data: { ...out, summary: practice.summarize(session) } });
});

const planOut = (p) => ({
  _id: p._id, title: p.title, examDate: formatDay(p.examDate), examSource: p.examSource, startDate: formatDay(p.startDate),
  minutesPerDay: p.minutesPerDay, restDays: p.restDays, warnings: p.warnings,
  items: p.items.map((i) => ({ ...i.toObject?.() ?? i, date: formatDay(i.date) })),
  done: p.items.filter((i) => i.done).length, total: p.items.length,
});

// POST /api/learning/plan  { examDate? | examId?, examName?, topics: [{subject, topic}], minutesPerDay, restDays?, startDate? }
exports.createPlan = asyncHandler(async (req, res) => {
  const student = await ownStudent(req);
  if (req.body?.examId) assertId(req.body.examId);
  const built = await buildPlan({ schoolId: req.schoolId, userId: req.user._id, student, input: req.body || {} });
  await RevisionPlan.updateMany({ school: req.schoolId, user: req.user._id, active: true }, { $set: { active: false } });
  const plan = await RevisionPlan.create({ school: req.schoolId, user: req.user._id, ...built, active: true });
  res.status(201).json({ success: true, data: planOut(plan) });
});

// GET /api/learning/plan  (the active plan, or null)
exports.getPlan = asyncHandler(async (req, res) => {
  const plan = await RevisionPlan.findOne({ school: req.schoolId, user: req.user._id, active: true }).sort({ updatedAt: -1 });
  res.json({ success: true, data: plan ? planOut(plan) : null });
});

// PATCH /api/learning/plan/:id/items/:itemId  { done: bool }
exports.markItem = asyncHandler(async (req, res) => {
  assertId(req.params.id);
  const plan = await RevisionPlan.findOne({ _id: req.params.id, school: req.schoolId, user: req.user._id });
  if (!plan) throw new HttpError(404, 'Plan not found');
  const item = plan.items.find((i) => i.id === req.params.itemId);
  if (!item) throw new HttpError(404, 'Plan item not found');
  item.done = req.body?.done === true;
  item.doneAt = item.done ? new Date() : null;
  await plan.save();
  res.json({ success: true, data: planOut(plan) });
});

// DELETE /api/learning/plan/:id
exports.deletePlan = asyncHandler(async (req, res) => {
  assertId(req.params.id);
  const r = await RevisionPlan.deleteOne({ _id: req.params.id, school: req.schoolId, user: req.user._id });
  if (!r.deletedCount) throw new HttpError(404, 'Plan not found');
  res.json({ success: true, message: 'Plan deleted' });
});

// GET /api/learning/progress  -> practice results by topic, recent sets, tutor sessions, plan progress. Counts only, no AI.
exports.progress = asyncHandler(async (req, res) => {
  const [stats, sessions, conversations, plan] = await Promise.all([
    practiceAccuracy({ schoolId: req.schoolId, userId: req.user._id }),
    PracticeSession.find({ school: req.schoolId, user: req.user._id }).sort({ createdAt: -1 }).limit(50),
    LearningConversation.countDocuments({ school: req.schoolId, user: req.user._id }),
    RevisionPlan.findOne({ school: req.schoolId, user: req.user._id, active: true }).sort({ updatedAt: -1 }).lean(),
  ]);
  const topics = Object.values(stats).map((v) => ({ subject: v.subject, topic: v.topic, right: v.right, total: v.total, accuracy: Math.round((v.right / v.total) * 100) }))
    .sort((a, b) => a.accuracy - b.accuracy);
  const today = toDayKey();
  res.json({
    success: true,
    data: {
      practice: {
        sets: sessions.length,
        answered: sessions.reduce((n, s) => n + practice.summarize(s).marked, 0),
        recent: sessions.slice(0, 5).map((s) => ({ _id: s._id, subject: s.subject, topic: s.topic, difficulty: s.difficulty, createdAt: s.createdAt, summary: practice.summarize(s) })),
      },
      topics,
      // A topic needs at least 3 marked answers before it is called weak or strong.
      weak: topics.filter((t) => t.total >= 3 && t.accuracy < 60),
      strong: topics.filter((t) => t.total >= 3 && t.accuracy >= 80),
      tutorConversations: conversations,
      plan: plan ? {
        title: plan.title, examDate: formatDay(plan.examDate), done: plan.items.filter((i) => i.done).length, total: plan.items.length,
        dueToday: plan.items.filter((i) => !i.done && formatDay(i.date) === formatDay(today)).length,
        overdue: plan.items.filter((i) => !i.done && i.date < today).length,
      } : null,
    },
  });
});
