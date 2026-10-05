// Conversation Manager: what UnifiedAI remembers between messages, and how it hands that to the model.
//
// Short-term conversation state only. It keeps the last few turns (redacted and shortened), the people and tickets that were
// just talked about, the topic, child and class in play. The model is never sent the whole transcript: it gets this compact
// context, plus the person's own recent tickets, and uses it to resolve "him", "that issue", "same as before", "still not fixed".
//
// Not kept: anything permanent about the person. Records live in their own collections; this state expires with the chat.

const AssistantTicket = require('../models/AssistantTicket');
const { redact } = require('./text');

const MAX_RECENT = 6;     // three exchanges
const MAX_PEOPLE = 5;
const MAX_TICKETS = 3;
const TICKET_LOOKBACK_MS = 30 * 24 * 3600 * 1000;

const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

// The person's own tickets that a new message could be about: open ones, and ones resolved in the last 14 days (for reopening).
async function recentTickets(user, schoolId, now = new Date(), limit = 5) {
  const since = new Date(now.getTime() - TICKET_LOOKBACK_MS);
  const rows = await AssistantTicket.find({ school: schoolId, raisedBy: user._id, createdAt: { $gte: since } })
    .sort({ lastActivityAt: -1 }).limit(limit).populate('student', 'name class section').lean();
  return rows.map((t) => ({
    id: String(t._id), number: t.number, status: t.status, priority: t.priority, domain: t.domain, title: t.title || null,
    summary: t.summary || null, question: t.question, student: t.student ? { name: t.student.name, class: `${t.student.class}-${t.student.section}` } : null,
    sentTo: (t.contacts || []).map((c) => ({ name: c.name, title: c.title })), createdAt: t.createdAt, lastActivityAt: t.lastActivityAt || t.updatedAt,
    resolvedAt: t.resolvedAt, assignees: (t.assignees || []).map(String), entities: t.entities || null, raw: t,
  }));
}

// What the model is told. Short on purpose.
function contextFor(conv, tickets = [], now = new Date()) {
  const s = conv.state || {};
  const lines = [];
  const recent = (s.recent || []).slice(-MAX_RECENT);
  if (recent.length) lines.push(`Recent messages (oldest first):\n${recent.map((r) => `${r.role === 'user' ? 'Person' : 'Assistant'}: ${r.text}`).join('\n')}`);
  if (s.people?.length) lines.push(`People just mentioned: ${s.people.map((p) => (p.title ? `${p.name} (${p.title})` : p.name)).join('; ')}`);
  if (tickets.length) {
    // The ticket raised or discussed in this chat is listed on its own: "unko bhi", "that issue", "still nothing" refer to it unless the
    // message names something else. Mixed into the person's other open tickets it gets lost, and a model picks another ticket of the same teacher.
    const here = (s.tickets || []).map((t) => t.number);
    const line = (t) => {
      const ageH = Math.max(0, Math.round((now - new Date(t.createdAt)) / 3600000));
      return `${t.number}: ${t.status}${t.priority === 'high' ? ', urgent' : ''}, raised ${ageH < 48 ? `${ageH}h` : `${Math.round(ageH / 24)}d`} ago, ${t.title || clip(t.summary || t.question, 90)}${t.student ? `, about ${t.student.name}` : ''}${t.sentTo.length ? `, with ${t.sentTo.map((x) => x.name).join(' and ')}` : ''}`;
    };
    const current = here.map((n) => tickets.find((t) => t.number === n)).filter(Boolean);
    const others = tickets.filter((t) => !current.includes(t));
    if (current.length) lines.push(`Ticket raised or discussed in THIS chat just now:\n${current.map(line).join('\n')}`);
    if (others.length) lines.push(`The person's other tickets (newest activity first):\n${others.map(line).join('\n')}`);
  }
  return lines.join('\n');
}

// After a request: remember the exchange, the people and tickets that came up.
function remember(conv, { userText, replies = [] }) {
  const s = conv.state;
  const now = new Date();
  s.recent = s.recent || [];
  if (userText) s.recent.push({ role: 'user', text: clip(redact(userText), 240), domain: null, at: now });
  const answer = replies.map((r) => r.text).filter(Boolean).join(' ');
  if (answer) s.recent.push({ role: 'assistant', text: clip(redact(answer), 240), domain: replies.find((r) => r.domain)?.domain || null, at: now });
  s.recent = s.recent.slice(-MAX_RECENT);

  for (const r of replies) {
    for (const c of r.ticket?.sentTo || []) {
      if (!c.name) continue;
      s.people = [{ name: c.name, title: c.title }, ...(s.people || []).filter((p) => p.name !== c.name)].slice(0, MAX_PEOPLE);
    }
    if (r.ticket?.number) {
      s.tickets = [{ number: r.ticket.number, domain: r.domain || '', title: clip(r.ticket.title || '', 100) }, ...(s.tickets || []).filter((t) => t.number !== r.ticket.number)].slice(0, MAX_TICKETS);
    }
  }
}

module.exports = { recentTickets, contextFor, remember, MAX_RECENT };
