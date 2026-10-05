// What the assistant says about an action. Built ONLY from the verified result of the action, never from what was attempted:
// a notification that failed is reported as failed, a ticket that could not be saved is not called raised.
// The standard wording here is plain English; the writer then puts it into the person's language and a friendly tone
// (it may change words, never ticket numbers, names or the facts: see writer.js).

const { teamLabel } = require('../handoff');

const list = (names) => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);
const days = (ms) => { const d = Math.round(ms / 86400000); return d < 1 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`; };

function withWhom(ticket) {
  const named = (ticket.contacts || []).filter((c) => c.title !== 'School office' || (ticket.contacts || []).length === 1);
  const names = named.slice(0, 2).map((c) => (c.title && c.title !== 'School office' ? `${c.name} (${c.title})` : c.name));
  return names.length ? list(names) : teamLabel(ticket.team).toLowerCase();
}

// -> { confirmed: [names], failed: [names] } from the notify results, ignoring the person themself.
function delivery(notified = []) {
  return { confirmed: notified.filter((n) => n.ok).map((n) => n.name), failed: notified.filter((n) => !n.ok).map((n) => n.name) };
}

function deliveryLine(d, { urgent = false } = {}) {
  if (!d.confirmed.length && !d.failed.length) return '';
  if (!d.failed.length) return ' They have been notified.';
  if (!d.confirmed.length) return ' I could not confirm that anyone was notified, but the ticket is saved and the school office can see it.';
  return ` ${list(d.confirmed)} ${d.confirmed.length > 1 ? 'have' : 'has'} been notified, but I could not confirm that ${list(d.failed)} ${d.failed.length > 1 ? 'were' : 'was'} reached.`;
}

// plan: { action, relation }, result: actions.run(...) output, p: the params sent to the action.
function describe(plan, result, { reason = null, now = new Date() } = {}) {
  const t = result.data?.ticket;
  const d = delivery(result.data?.notified);

  if (!result.ok) {
    if (result.state === 'denied' || result.denied) {
      const tn = plan.ticket?.number || 'that ticket';
      if (result.error === 'already_urgent') return { kind: 'blocked', text: `${tn} is already marked urgent and the school management can see it, so there is nothing more to escalate. I can add a note for them if you like.` };
      if (result.error === 'resolved' && plan.action === 'ticket.repeat') return { kind: 'blocked', text: `${tn} has been resolved. If the problem is back, tell me and I will reopen it.` };
      if (result.error === 'resolved') return { kind: 'blocked', text: `${tn} has been resolved. If the problem is back, tell me and I will reopen it.` };
      if (result.error === 'too_old') return { kind: 'blocked', text: `${tn} was resolved more than 14 days ago, so it cannot be reopened. I can raise a new ticket instead.` };
      if (result.error === 'not_resolved') return { kind: 'blocked', text: `${tn} is still open, so there is nothing to reopen.` };
      if (result.error === 'not_yours') return { kind: 'blocked', text: 'I can only look at or update tickets that you raised yourself.' };
      return { kind: 'blocked', text: 'I cannot do that on this ticket.' };
    }
    // It ran, but reading the result back did not confirm it: it may well have happened, so never say nothing changed and never invite a resend.
    if (result.state === 'unverified') {
      const tn = t?.number ? ` (ticket ${t.number})` : '';
      const did = { 'ticket.create': 'raise this with the school', 'ticket.follow_up': 'add your update', 'ticket.repeat': 'note that you asked again', 'ticket.escalate': 'escalate it', 'ticket.reopen': 'reopen it' }[plan.action] || 'do that';
      return { kind: 'uncertain', text: `I tried to ${did}${tn}, but I could not confirm the final result. It may have gone through. Please open Requests to check before sending it again, so it is not done twice. The school office can also see it.` };
    }
    // Failed part-way and nobody can tell whether anything was saved.
    if (result.state === 'error') {
      return { kind: 'uncertain', text: 'Something went wrong while I was doing that, and I cannot tell whether it went through. Please open Requests to check before asking again, so it is not done twice.' };
    }
    // invalid / not_executed: it did not change anything, and that is confirmed.
    return { kind: 'failed', text: 'I could not complete that just now, and nothing was changed. Your message is not lost: tap the button below to try again, or contact the school office directly.' };
  }

  // A ticket from a moment ago was found for the same report: nothing new was created and nobody was told again.
  if (plan.action === 'ticket.create' && result.data?.healed) {
    return { kind: 'repeat', text: `I had saved this earlier but it had not reached anyone. I have now passed it to ${withWhom(t)} (ticket ${t.number}).${deliveryLine(d)}` };
  }
  if (plan.action === 'ticket.create' && result.data?.deduped) {
    return { kind: 'repeat', text: `I have already raised this with ${withWhom(t)} a moment ago (ticket ${t.number}), so I have not opened a second one.` };
  }
  const recoveredNote = result.data?.recovered ? ' I could not confirm that anyone was notified, but the ticket is saved and the school office can see it.' : '';

  switch (plan.action) {
    case 'ticket.create': {
      const to = withWhom(t);
      const eff = t.reason || reason; // the stored reason: a ticket that is not urgent by policy is not described as urgent
      if (eff === 'sensitive' && t.priority === 'high') return { kind: 'created', text: `I am sorry this happened. I have raised it as urgent with ${to} and the school management (ticket ${t.number}).${recoveredNote || deliveryLine(d)} Someone from the school will contact you soon. If anyone is in danger right now, please call the school directly or dial 112.` };
      if (eff === 'complaint' || eff === 'sensitive') return { kind: 'created', text: `Thank you for telling us. I have raised your complaint with ${to} (ticket ${t.number}).${recoveredNote || deliveryLine(d)} Their reply will come here in the app.` };
      return { kind: 'created', text: `I have raised this with ${to} (ticket ${t.number}), with a short summary so you will not have to explain it again.${recoveredNote || deliveryLine(d)} Their reply will come here in the app.` };
    }
    case 'ticket.follow_up':
      return { kind: 'followed_up', text: `I have added your update to your existing ticket ${t.number} with ${withWhom(t)}, so you do not need a new one.${deliveryLine(d)}` };
    case 'ticket.repeat': {
      const waited = days(now - new Date(plan.ticket?.createdAt || t.createdAt));
      return { kind: 'repeat', text: `You already have an open ticket about this: ${t.number} with ${withWhom(t)}, raised ${waited}. I have noted that you asked again, so I have not opened a second one.${result.data.nudged ? ` It has been waiting for a reply, so I have sent them a reminder.${deliveryLine(d)}` : ' It is still with them.'}` };
    }
    case 'ticket.escalate':
      return { kind: 'escalated', text: `I have escalated ${t.number} to urgent and added the school management.${deliveryLine(d)}` };
    case 'ticket.reopen':
      return { kind: 'reopened', text: `I have reopened ${t.number} with ${withWhom(t)}.${deliveryLine(d)}` };
    case 'ticket.status': return { kind: 'status', text: statusText(t, now) };
    default: return { kind: 'unknown', text: '' };
  }
}

function statusText(t, now) {
  if (!t) return 'I could not find that ticket.';
  const status = t.status === 'resolved' ? 'resolved' : t.status === 'in_progress' ? 'being worked on' : 'open and waiting for a reply';
  const last = [...(t.notes || [])].reverse().find((n) => n.kind === 'note' && n.by && n.by.role !== 'student' && n.by.role !== 'parent');
  const staffNote = last ? ` ${last.by.name || 'Staff'} wrote: "${String(last.text).slice(0, 200)}".` : '';
  const when = t.status === 'resolved' && t.resolvedAt ? ` It was resolved ${days(now - new Date(t.resolvedAt))}.` : ` It was raised ${days(now - new Date(t.createdAt))}.`;
  return `Ticket ${t.number} is ${status}.${when}${staffNote}${!staffNote && t.status !== 'resolved' ? ' There is no reply from staff yet.' : ''}`;
}

// What goes to the app next to the reply.
function ticketPayload(plan, result, kind) {
  const t = result.data?.ticket;
  if (!t) return null;
  const d = delivery(result.data?.notified);
  return {
    id: String(t._id), number: t.number, title: t.title || null, status: t.status, priority: t.priority, outcome: kind, team: teamLabel(t.team),
    sentTo: (t.contacts || []).map((c) => ({ name: c.name, title: c.title })), notified: d,
  };
}

module.exports = { describe, ticketPayload, delivery, statusText, withWhom };
