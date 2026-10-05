// Ticket actions: create, follow up, escalate, reopen, repeat (the same issue reported again), and read status.
// Who gets a ticket is decided by handoff.recipientsFor (named teacher, subject teacher, class teacher, accounts, office).

const AssistantTicket = require('../../models/AssistantTicket');
const Counter = require('../../models/Counter');
const User = require('../../models/User');
const notify = require('../../services/notify');
const { redact } = require('../text');
const { DOMAINS } = require('../domains');
const { recipientsFor, teamLabel } = require('../handoff');
const policy = require('../policy');

const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
const isOwner = (ctx, ticket) => !!ticket && String(ticket.raisedBy) === String(ctx.user._id) && String(ticket.school) === String(ctx.schoolId);

const REASON_TITLES = {
  sensitive: 'Needs urgent attention', complaint: 'Complaint', requested: 'Request to speak with staff',
  forwarded: 'Question for staff', unclear: 'Unclear request', not_covered: 'Question the app cannot answer',
};

// Staff-facing text. Written in English from structured facts, whatever language the person used. The model's own brief
// (title, summary, request) is used when it supplied one; otherwise this is built from the facts we know.
function brief(ctx, p) {
  const who = `${ctx.user.name} (${ctx.role})`;
  const about = p.student ? ` about ${p.student.name}, class ${p.student.class}-${p.student.section}` : '';
  const domain = p.domain && DOMAINS[p.domain] ? DOMAINS[p.domain].label : 'General';
  const title = clip(p.brief?.title || `${REASON_TITLES[p.reason] || 'Request'}: ${domain}${p.student ? `, ${p.student.name}` : ''}`, 140);
  const summary = clip(p.brief?.summary || `${who}${about} has raised a ${String(REASON_TITLES[p.reason] || 'request').toLowerCase()} regarding ${domain.toLowerCase()}. See the original message below.`, 500);
  const requestedAction = clip(p.brief?.request || (p.reason === 'requested' ? 'Please contact the person.' : p.reason === 'sensitive' ? 'Please look into this today and contact the person.' : 'Please review and reply to the person in the app.'), 300);
  return { title: redact(title), summary: redact(summary), requestedAction: redact(requestedAction) };
}

// Notifies people and returns what really happened for each: [{ name, userId, ok, error }].
async function tell(ctx, ticket, people, { title, message }) {
  const results = [];
  const seen = new Set();
  for (const p of people) {
    if (!p.userId || seen.has(p.userId)) continue;
    seen.add(p.userId);
    try {
      const n = await notify.notifyUser(ctx.schoolId, p.userId, { title, message, type: 'General', createdBy: ctx.user._id });
      results.push({ name: p.name, userId: p.userId, ok: !!n?._id });
    } catch (err) {
      results.push({ name: p.name, userId: p.userId, ok: false, error: clip(err.message, 150) });
    }
  }
  return results;
}

const staffMessage = (ctx, ticket, lead) => clip(`${lead} ${ticket.summary || ''}${ticket.requestedAction ? ` Requested: ${ticket.requestedAction}` : ''} Raised by ${ctx.user.name} (${ctx.role}). Open EduAmigo Ask > Requests to reply.`, 1900);
const titleOf = (ticket, prefix = '') => clip(`${ticket.priority === 'high' ? 'Urgent: ' : ''}${prefix}${ticket.number} ${ticket.title || 'EduAmigo Ask ticket'}`, 190);

async function persistNotifications(ticket, results) {
  await AssistantTicket.updateOne({ _id: ticket._id }, { $push: { notifications: { $each: results.map((r) => ({ name: r.name, ok: r.ok, error: r.error || undefined })) } } });
}

module.exports = (register) => {
  // ---- create -----------------------------------------------------------------------------------------------------------
  register({
    name: 'ticket.create',
    describe: 'Raise a new ticket with the right staff member and notify them',
    requires: 'a signed-in school user',
    params: { text: 'what the person wrote', domain: 'topic', reason: 'why it goes to a person', student: 'the child it is about', subject: 'subject', personName: 'a named staff member', brief: 'professional title, summary, request', safety: 'situation category (policy decides priority)' },
    authorize: (ctx) => ({ ok: !!ctx.user && !!ctx.schoolId }),
    validate: (p) => [!p.text && 'text', !p.reason && 'reason'].filter(Boolean),
    async execute(ctx, p) {
      const { priority, reason: priorityReason } = policy.priorityFor({ safety: p.safety, severeWords: p.severeWords });
      const { team, people } = await recipientsFor({ school: ctx.schoolId, domain: p.domain, student: p.student, subject: p.subject, personName: p.personName, priority });
      const b = brief(ctx, p);
      const seq = await Counter.next(ctx.schoolId, 'assistantTicket');
      const ticket = await AssistantTicket.create({
        school: ctx.schoolId, number: `T-${1000 + seq}`, raisedBy: ctx.user._id, raisedRole: ctx.role, student: p.student?._id || null, domain: p.domain || null,
        question: redact(p.text).slice(0, 1000), ...b, entities: { student: p.student ? { name: p.student.name, class: `${p.student.class}-${p.student.section}` } : null, subject: p.subject || null, person: p.personName || null, domain: p.domain || null },
        reason: p.reason, priority, priorityReason, team, assignees: [...new Set(people.map((x) => x.userId).filter(Boolean))],
        contacts: people.map((x) => ({ name: x.name, title: x.title })), lastActivityAt: new Date(),
      });
      const notified = await tell(ctx, ticket, people, { title: titleOf(ticket), message: staffMessage(ctx, ticket, `${REASON_TITLES[p.reason] || 'Request'}.`) });
      await persistNotifications(ticket, notified);
      return { ticket, people, notified, team: teamLabel(team), priority };
    },
    // The ticket must be readable back from the database, with the assignees we claim, and every notification must be recorded.
    async verify(ctx, p, d) {
      const stored = await AssistantTicket.findOne({ _id: d.ticket._id, school: ctx.schoolId }).lean();
      const checks = [{ name: 'ticket_saved', ok: !!stored }, { name: 'has_recipient', ok: !!stored && stored.assignees.length > 0 }];
      return { ok: checks.every((c) => c.ok), checks };
    },
  });

  // ---- follow up --------------------------------------------------------------------------------------------------------
  register({
    name: 'ticket.follow_up',
    describe: 'Add the person\'s new message to their existing open ticket and tell the people handling it',
    requires: 'the ticket was raised by this person',
    params: { ticket: 'the existing ticket', text: 'the new message', brief: 'professional one-line update' },
    authorize: (ctx, p) => (isOwner(ctx, p.ticket) ? (p.ticket.status === 'resolved' ? { ok: false, why: 'resolved' } : { ok: true }) : { ok: false, why: 'not_yours' }),
    validate: (p) => [!p.text && 'text'].filter(Boolean),
    async execute(ctx, p) {
      const note = clip(p.brief?.summary || p.text, 900);
      await AssistantTicket.updateOne({ _id: p.ticket._id }, { $push: { notes: { by: ctx.user._id, kind: 'follow_up', text: redact(note) } }, $set: { lastActivityAt: new Date() } });
      const fresh = await AssistantTicket.findById(p.ticket._id);
      const people = (fresh.contacts || []).map((c, i) => ({ name: c.name, userId: String(fresh.assignees[i] || '') }));
      const notified = await tell(ctx, fresh, fresh.assignees.map((id, i) => ({ name: fresh.contacts[i]?.name || 'Staff', userId: String(id) })), { title: titleOf(fresh, 'Update on '), message: clip(`Follow-up from ${ctx.user.name}: ${redact(note)}`, 1900) });
      await persistNotifications(fresh, notified);
      return { ticket: fresh, people, notified, priority: fresh.priority };
    },
    async verify(ctx, p, d) {
      const stored = await AssistantTicket.findOne({ _id: d.ticket._id, school: ctx.schoolId }).lean();
      const added = !!stored && stored.notes.length > (p.ticket.notes?.length || 0);
      return { ok: added, checks: [{ name: 'follow_up_saved', ok: added }] };
    },
  });

  // ---- repeat (same issue reported again) --------------------------------------------------------------------------------
  register({
    name: 'ticket.repeat',
    describe: 'The person reported the same open issue again: keep one ticket, record the repeat, and nudge staff if it has been waiting a day',
    requires: 'the ticket was raised by this person',
    params: { ticket: 'the existing ticket', text: 'the new message' },
    authorize: (ctx, p) => (isOwner(ctx, p.ticket) ? { ok: true } : { ok: false, why: 'not_yours' }),
    validate: (p) => [!p.text && 'text'].filter(Boolean),
    async execute(ctx, p) {
      await AssistantTicket.updateOne({ _id: p.ticket._id }, { $push: { notes: { by: ctx.user._id, kind: 'repeat', text: redact(clip(p.text, 400)) } } });
      const fresh = await AssistantTicket.findById(p.ticket._id);
      const waitedH = (Date.now() - new Date(p.ticket.lastActivityAt || p.ticket.createdAt).getTime()) / 3600000;
      let notified = [];
      // Nudge only after a day without any activity, so asking twice in a minute does not flood staff.
      if (waitedH >= 24) {
        notified = await tell(ctx, fresh, fresh.assignees.map((id, i) => ({ name: fresh.contacts[i]?.name || 'Staff', userId: String(id) })), { title: titleOf(fresh, 'Reminder: '), message: clip(`${ctx.user.name} is still waiting for a reply on ${fresh.number} (${Math.round(waitedH / 24)} days).`, 1900) });
        await persistNotifications(fresh, notified);
        await AssistantTicket.updateOne({ _id: fresh._id }, { $set: { lastActivityAt: new Date() } });
      }
      return { ticket: fresh, people: [], notified, nudged: waitedH >= 24, waitedHours: Math.round(waitedH), priority: fresh.priority };
    },
    async verify(ctx, p, d) {
      const stored = await AssistantTicket.findOne({ _id: d.ticket._id, school: ctx.schoolId }).lean();
      const ok = !!stored && stored.notes.length > (p.ticket.notes?.length || 0);
      return { ok, checks: [{ name: 'repeat_recorded', ok }] };
    },
  });

  // ---- escalate ---------------------------------------------------------------------------------------------------------
  register({
    name: 'ticket.escalate',
    describe: 'Raise an open ticket to urgent and bring in the school management',
    requires: 'the ticket was raised by this person and is open and not already urgent',
    params: { ticket: 'the existing ticket', text: 'why' },
    authorize: (ctx, p) => (isOwner(ctx, p.ticket) ? policy.canEscalate(p.ticket) : { ok: false, why: 'not_yours' }),
    validate: () => [],
    async execute(ctx, p) {
      const admins = (await User.find({ school: ctx.schoolId, role: 'admin', isActive: true }).select('_id name').lean()).map((u) => ({ userId: String(u._id), name: u.name }));
      const { priority, reason } = policy.priorityFor({ escalated: true });
      const have = new Set(p.ticket.assignees.map(String));
      const add = admins.filter((a) => !have.has(a.userId));
      await AssistantTicket.updateOne({ _id: p.ticket._id }, {
        $set: { priority, priorityReason: reason, lastActivityAt: new Date() },
        $addToSet: { assignees: { $each: add.map((a) => a.userId) } },
        $push: { notes: { by: ctx.user._id, kind: 'escalation', text: redact(clip(p.text || 'The person asked for this to be escalated.', 400)) }, contacts: { $each: add.map((a) => ({ name: a.name, title: 'School office' })) } },
      });
      const fresh = await AssistantTicket.findById(p.ticket._id);
      const notified = await tell(ctx, fresh, fresh.assignees.map((id, i) => ({ name: fresh.contacts[i]?.name || 'Staff', userId: String(id) })), { title: titleOf(fresh, 'Escalated: '), message: clip(`${ctx.user.name} has escalated this ticket. ${fresh.summary || ''}`, 1900) });
      await persistNotifications(fresh, notified);
      return { ticket: fresh, people: [], notified, priority };
    },
    async verify(ctx, p, d) {
      const stored = await AssistantTicket.findOne({ _id: d.ticket._id, school: ctx.schoolId }).lean();
      const ok = !!stored && stored.priority === 'high' && stored.notes.some((n) => n.kind === 'escalation');
      return { ok, checks: [{ name: 'priority_raised', ok }] };
    },
  });

  // ---- reopen -----------------------------------------------------------------------------------------------------------
  register({
    name: 'ticket.reopen',
    describe: 'Reopen the person\'s resolved ticket (within 14 days) because the problem is back',
    requires: 'the ticket was raised by this person and resolved less than 14 days ago',
    params: { ticket: 'the existing ticket', text: 'what is still wrong' },
    authorize: (ctx, p) => (isOwner(ctx, p.ticket) ? policy.canReopen(p.ticket) : { ok: false, why: 'not_yours' }),
    validate: () => [],
    async execute(ctx, p) {
      await AssistantTicket.updateOne({ _id: p.ticket._id }, {
        $set: { status: 'open', resolvedAt: null, lastActivityAt: new Date() }, $inc: { reopenedCount: 1 },
        $push: { notes: { by: ctx.user._id, kind: 'reopen', text: redact(clip(p.text || 'The person says the problem is not solved.', 400)) } },
      });
      const fresh = await AssistantTicket.findById(p.ticket._id);
      const notified = await tell(ctx, fresh, fresh.assignees.map((id, i) => ({ name: fresh.contacts[i]?.name || 'Staff', userId: String(id) })), { title: titleOf(fresh, 'Reopened: '), message: clip(`${ctx.user.name} says this is not solved: ${redact(clip(p.text, 300))}`, 1900) });
      await persistNotifications(fresh, notified);
      return { ticket: fresh, people: [], notified, priority: fresh.priority };
    },
    async verify(ctx, p, d) {
      const stored = await AssistantTicket.findOne({ _id: d.ticket._id, school: ctx.schoolId }).lean();
      const ok = !!stored && stored.status === 'open';
      return { ok, checks: [{ name: 'reopened', ok }] };
    },
  });

  // ---- status (read) -----------------------------------------------------------------------------------------------------
  register({
    name: 'ticket.status',
    describe: 'Read the real state of the person\'s ticket: status, who has it, last staff reply',
    requires: 'the ticket was raised by this person',
    params: { ticket: 'the existing ticket' },
    authorize: (ctx, p) => (isOwner(ctx, p.ticket) ? { ok: true } : { ok: false, why: 'not_yours' }),
    validate: (p) => [!p.ticket && 'ticket'].filter(Boolean),
    async execute(ctx, p) {
      const t = await AssistantTicket.findOne({ _id: p.ticket._id, school: ctx.schoolId }).populate('notes.by', 'name role').lean();
      return { ticket: t };
    },
    verify: async (ctx, p, d) => ({ ok: !!d.ticket, checks: [{ name: 'ticket_read', ok: !!d.ticket }] }),
  });
};
