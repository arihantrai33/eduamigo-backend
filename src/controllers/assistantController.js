const AssistantQuery = require('../models/AssistantQuery');
const AssistantTicket = require('../models/AssistantTicket');
const engine = require('../assistant/engine');
const { schoolMetrics } = require('../assistant/metrics');
const { evaluate } = require('../assistant/eval');
const llm = require('../assistant/llm');
const { DOMAINS, domainsForRole } = require('../assistant/domains');
const { suggestionsFor } = require('../assistant/skills/general');
const { notifyUser } = require('../services/notify');
const { hasPermission } = require('../config/permissions');
const { HttpError, asyncHandler, isValidId } = require('../utils/http');
const { audit } = require('../services/audit');

const CHOICE_TYPES = ['domain', 'student', 'class', 'staff', 'handoff', 'ask'];

// POST /api/assistant/ask  { message, conversationId?, choice?: { type, value } }
const ask = asyncHandler(async (req, res) => {
  const message = typeof req.body?.message === 'string' ? req.body.message : '';
  let choice = null;
  if (req.body?.choice) {
    const { type, value } = req.body.choice;
    if (!CHOICE_TYPES.includes(type)) throw new HttpError(400, 'Invalid choice');
    choice = { type, value: String(value ?? '').slice(0, 200), label: message };
  }
  if (!message.trim() && !choice) throw new HttpError(400, 'Please type a question');
  if (message.length > 500) throw new HttpError(400, 'Please keep your question under 500 characters');
  const conversationId = req.body?.conversationId && isValidId(req.body.conversationId) ? req.body.conversationId : null;

  const result = await engine.ask({
    user: req.user, school: req.school, entitlements: req.entitlements, message, conversationId, choice,
  });
  for (const r of result.replies) {
    if (r.ticket) audit(req, 'assistant.handoff', { targetType: 'assistant_ticket', targetId: r.ticket.id, details: { number: r.ticket.number, domain: r.domain } });
  }
  res.json({ success: true, data: result });
});

// POST /api/assistant/feedback  { queryId, helpful: true|false }
const feedback = asyncHandler(async (req, res) => {
  const { queryId, helpful } = req.body || {};
  if (!isValidId(queryId) || typeof helpful !== 'boolean') throw new HttpError(400, 'queryId and helpful (true or false) are required');
  const q = await AssistantQuery.findOneAndUpdate(
    { _id: queryId, user: req.user._id, school: req.schoolId },
    { feedback: { helpful, at: new Date() } },
    { returnDocument: 'after' },
  );
  if (!q) throw new HttpError(404, 'Question not found');
  res.json({ success: true });
});

// GET /api/assistant/intro - topics and starter questions for the chat screen
const intro = asyncHandler(async (req, res) => {
  const topics = domainsForRole(req.user.role)
    .filter((d) => d !== 'general' && (!DOMAINS[d].feature || req.entitlements.features.includes(DOMAINS[d].feature)))
    .map((d) => ({ key: d, label: DOMAINS[d].label }));
  res.json({ success: true, data: { topics, suggestions: suggestionsFor(req.user.role), school: req.school?.name } });
});

const ticketView = (t) => ({
  id: String(t._id), number: t.number, status: t.status, priority: t.priority, reason: t.reason, domain: t.domain,
  domainLabel: DOMAINS[t.domain]?.label || null, team: t.team, question: t.question,
  raisedBy: t.raisedBy ? { id: String(t.raisedBy._id || t.raisedBy), name: t.raisedBy.name, role: t.raisedRole } : null,
  student: t.student ? { id: String(t.student._id || t.student), name: t.student.name, class: t.student.class ? `${t.student.class}-${t.student.section}` : null } : null,
  notes: (t.notes || []).map((n) => ({ text: n.text, at: n.at, by: n.by?.name || null })),
  createdAt: t.createdAt, resolvedAt: t.resolvedAt,
});

const canSeeAll = (user) => hasPermission(user.role, 'assistant.insights');

// GET /api/assistant/tickets?status=open|in_progress|resolved&scope=mine|assigned|all
//   mine     - tickets I raised (everyone)
//   assigned - tickets sent to me (default for staff)
//   all      - every ticket in the school (assistant.insights)
const listTickets = asyncHandler(async (req, res) => {
  const scope = req.query.scope || (['student', 'parent'].includes(req.user.role) ? 'mine' : 'assigned');
  const q = { school: req.schoolId };
  if (scope === 'mine') q.raisedBy = req.user._id;
  else if (scope === 'assigned') q.assignees = req.user._id;
  else if (scope === 'all') { if (!canSeeAll(req.user)) throw new HttpError(403, 'You do not have permission to see every ticket'); }
  else throw new HttpError(400, 'Invalid scope');
  if (req.query.status) {
    if (!['open', 'in_progress', 'resolved'].includes(req.query.status)) throw new HttpError(400, 'Invalid status');
    q.status = req.query.status;
  }
  const tickets = await AssistantTicket.find(q).sort({ status: 1, priority: 1, createdAt: -1 }).limit(200)
    .populate('raisedBy', 'name').populate('student', 'name class section').populate('notes.by', 'name').lean();
  res.json({ success: true, data: tickets.map(ticketView) });
});

// PATCH /api/assistant/tickets/:id  { status?, note? } - assignees and admins
const updateTicket = asyncHandler(async (req, res) => {
  if (!isValidId(req.params.id)) throw new HttpError(400, 'Invalid ticket');
  const t = await AssistantTicket.findOne({ _id: req.params.id, school: req.schoolId });
  if (!t) throw new HttpError(404, 'Ticket not found');
  const assigned = t.assignees.some((a) => String(a) === String(req.user._id));
  if (!assigned && !canSeeAll(req.user)) throw new HttpError(403, 'This ticket is not assigned to you');

  const { status, note } = req.body || {};
  if (status !== undefined && !['open', 'in_progress', 'resolved'].includes(status)) throw new HttpError(400, 'Invalid status');
  const text = typeof note === 'string' ? note.trim().slice(0, 1000) : '';
  if (!status && !text) throw new HttpError(400, 'Nothing to update');
  const wasResolved = t.status === 'resolved';
  if (status) { t.status = status; t.resolvedAt = status === 'resolved' ? new Date() : null; }
  if (text) t.notes.push({ by: req.user._id, text });
  await t.save();

  if (t.status === 'resolved' && !wasResolved) {
    await notifyUser(req.schoolId, t.raisedBy, {
      title: `Your request ${t.number} is resolved`,
      message: text || 'The school has resolved the question you sent through EduAmigo Ask.',
      type: 'General', createdBy: req.user._id,
    }).catch(() => null);
  } else if (text) {
    await notifyUser(req.schoolId, t.raisedBy, { title: `Update on ${t.number}`, message: text, type: 'General', createdBy: req.user._id }).catch(() => null);
  }
  audit(req, 'assistant.ticket_updated', { targetType: 'assistant_ticket', targetId: t._id, details: { number: t.number, status: t.status, noted: !!text } });
  const fresh = await AssistantTicket.findById(t._id).populate('raisedBy', 'name').populate('student', 'name class section').populate('notes.by', 'name').lean();
  res.json({ success: true, data: ticketView(fresh) });
});

// GET /api/assistant/metrics?days=30
const metrics = asyncHandler(async (req, res) => {
  const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
  res.json({ success: true, data: { ...(await schoolMetrics(req.schoolId, { days })), model: llm.status() } });
});

// GET /api/assistant/evaluation - routing accuracy on the labelled question set (keyword router, no cost)
const evaluation = asyncHandler(async (req, res) => {
  const report = await evaluate({ useModel: false });
  res.json({ success: true, data: report });
});

module.exports = { ask, feedback, intro, listTickets, updateTicket, metrics, evaluation };
