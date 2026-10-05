// Policy decisions that the model is NOT allowed to make: ticket priority and who may escalate.
//
// The model may describe a situation ("safety": harassment, payment dispute ...). The school's policy, written here, decides
// what that means. A model that says "urgent" for anything else is ignored, so priority cannot be talked up or down by wording
// (or by a prompt injection).

// Situations that always need a person's attention at once, and why.
const HIGH_PRIORITY = {
  safety: 'A safety concern is always urgent.',
  harassment: 'Bullying, harassment or abuse is always urgent.',
  medical: 'A medical or injury concern is always urgent.',
  payment_dispute: 'A payment dispute (wrong or double charge) is always urgent.',
};

const SAFETY_CATEGORIES = ['none', ...Object.keys(HIGH_PRIORITY)];

// -> { priority: 'normal' | 'high', reason }
function priorityFor({ safety = 'none', severeWords = false, escalated = false } = {}) {
  if (severeWords) return { priority: 'high', reason: 'Safety words in the message are always urgent.' };
  if (HIGH_PRIORITY[safety]) return { priority: 'high', reason: HIGH_PRIORITY[safety] };
  if (escalated) return { priority: 'high', reason: 'The person asked for this to be escalated.' };
  return { priority: 'normal', reason: 'Routine request.' };
}

// A person may escalate their own open ticket once; a ticket that is already urgent or already resolved cannot be escalated.
function canEscalate(ticket) {
  if (!ticket) return { ok: false, why: 'missing' };
  if (ticket.status === 'resolved') return { ok: false, why: 'resolved' };
  if (ticket.priority === 'high') return { ok: false, why: 'already_urgent' };
  return { ok: true };
}

// A resolved ticket can be reopened by the person who raised it for 14 days.
const REOPEN_WINDOW_MS = 14 * 24 * 3600 * 1000;
function canReopen(ticket, now = new Date()) {
  if (!ticket) return { ok: false, why: 'missing' };
  if (ticket.status !== 'resolved') return { ok: false, why: 'not_resolved' };
  const since = ticket.resolvedAt ? new Date(ticket.resolvedAt).getTime() : new Date(ticket.updatedAt).getTime();
  if (now.getTime() - since > REOPEN_WINDOW_MS) return { ok: false, why: 'too_old' };
  return { ok: true };
}

module.exports = { priorityFor, canEscalate, canReopen, SAFETY_CATEGORIES, HIGH_PRIORITY, REOPEN_WINDOW_MS };
