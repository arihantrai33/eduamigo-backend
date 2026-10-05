// Action planner: turns what the person meant into the one action that fits, given their existing tickets.
//
// Not a keyword matcher. The model reads the message together with the person's own ticket list and says how the message relates
// to them (a new issue, a follow-up, a repeat, an escalation, a reopening, a status question). The planner checks that claim
// against the real tickets (the ticket must be the person's own), and falls back to a similarity rule when there is no model.
// Result: { action, ticket, relation, via } where action is a contract name from actions/.

const { tokenize } = require('./text');

const RELATIONS = ['new', 'follow_up', 'repeat', 'escalate', 'reopen', 'status'];

const words = (s) => new Set(tokenize(s).filter((t) => t.length > 2));
function overlap(a, b) {
  const x = words(a); const y = words(b);
  if (!x.size || !y.size) return 0;
  return [...x].filter((t) => y.has(t)).length / Math.min(x.size, y.size);
}

const isOpen = (t) => t.status !== 'resolved';
const DAY = 24 * 3600 * 1000;

// The most likely existing ticket for a new report, by rules: same topic, same child, same person, similar words, recent, open.
function similarOpenTicket(tickets, { text, domain, student, personName, subject = null }, now = new Date()) {
  let best = null;
  for (const t of tickets) {
    if (!isOpen(t) || now - new Date(t.createdAt) > 14 * DAY) continue;
    if (domain && t.domain && domain !== t.domain) continue;
    if (student && t.student && student.name !== t.student.name) continue;
    if (personName && t.sentTo.length && !t.sentTo.some((c) => c.name.toLowerCase().includes(String(personName).toLowerCase().split(' ')[0]))) continue;
    if (subject && t.entities?.subject && String(subject).toLowerCase().slice(0, 4) !== String(t.entities.subject).toLowerCase().slice(0, 4)) continue; // another subject is another issue
    const score = overlap(text, `${t.title || ''} ${t.summary || ''} ${t.question || ''}`);
    if (score > (best?.score || 0)) best = { ticket: t, score };
  }
  // Same topic, same child, same person and recent already narrow it down, so 40% shared words is enough to call it the same issue.
  return best && best.score >= 0.4 ? best : null;
}

// A model that sees a list of tickets tends to attach a new message to one of them. The claim is only accepted when nothing
// contradicts it: the same topic (or one is unknown), the same child, and the same staff member or subject when they are named.
function compatible(ticket, { domain, student, personName, subject }) {
  if (domain && ticket.domain && domain !== ticket.domain) return false;
  if (student && ticket.student && student.name !== ticket.student.name) return false;
  if (personName && ticket.sentTo.length && !ticket.sentTo.some((c) => c.name.toLowerCase().includes(String(personName).toLowerCase().split(' ')[0]))) return false;
  if (subject && ticket.entities?.subject && String(subject).toLowerCase().slice(0, 4) !== String(ticket.entities.subject).toLowerCase().slice(0, 4)) return false;
  return true;
}

// part: an understood message part (kind, ticket: { relation, number }, ...). tickets: the person's own tickets (conversation.recentTickets).
function plan(part, { tickets = [], text, domain, student = null, personName = null, inChat = [], now = new Date() } = {}) {
  const claimed = part.ticket?.relation && RELATIONS.includes(part.ticket.relation) ? part.ticket.relation : null;
  // The model may name a ticket; it only counts if it is one of the person's own.
  const named = part.ticket?.number ? tickets.find((t) => t.number.toLowerCase() === String(part.ticket.number).toLowerCase()) : null;

  if (part.kind === 'ticket_status') {
    // With no ticket named, "what happened to my complaint" is about the one just discussed in this chat, then the newest open one.
    const here = inChat.map((n) => tickets.find((t) => t.number === n)).find(Boolean);
    const target = named || here || (tickets.length === 1 ? tickets[0] : tickets.find(isOpen) || tickets[0] || null);
    return { action: 'ticket.status', ticket: target, relation: 'status', via: named ? 'model' : here ? 'chat' : 'rules' };
  }

  const claimOk = named && claimed && claimed !== 'new' && (['status', 'escalate'].includes(claimed) || compatible(named, { domain, student, personName: part.person, subject: part.subject }));
  if (named && claimed && claimed !== 'new' && claimOk) {
    if (claimed === 'status') return { action: 'ticket.status', ticket: named, relation: claimed, via: 'model' };
    if (claimed === 'escalate') return { action: 'ticket.escalate', ticket: named, relation: claimed, via: 'model' };
    if (claimed === 'reopen' || (claimed === 'follow_up' && !isOpen(named))) return { action: 'ticket.reopen', ticket: named, relation: 'reopen', via: 'model' };
    if (claimed === 'repeat') return { action: 'ticket.repeat', ticket: named, relation: claimed, via: 'model' };
    return { action: 'ticket.follow_up', ticket: named, relation: 'follow_up', via: 'model' };
  }
  // "New" is believed, except for a ticket opened a moment ago in this same request (the model could not have seen it).
  const fresh = similarOpenTicket(tickets.filter((t) => t.freshInRequest), { text, domain, student, personName, subject: part.subject }, now);
  if (claimed === 'new' && !fresh) return { action: 'ticket.create', ticket: null, relation: 'new', via: 'model' };

  // No model reading of the ticket relation (or the model named nothing usable): the same report again is one ticket, not two.
  const dup = similarOpenTicket(tickets, { text, domain, student, personName, subject: part.subject }, now);
  if (dup) return { action: 'ticket.repeat', ticket: dup.ticket, relation: 'repeat', via: 'rules' };
  return { action: 'ticket.create', ticket: null, relation: 'new', via: 'rules' };
}

module.exports = { plan, similarOpenTicket, overlap, RELATIONS };
