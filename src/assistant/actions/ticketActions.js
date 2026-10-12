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
const crypto = require('crypto');


// One ticket per person, child and wording within a two-minute window, enforced by a unique index so that two requests that
// arrive at the same moment (a double tap, a retry) cannot both create it. The previous window is checked too, so a request
// straddling the boundary is still recognised.
const WINDOW_MS = 2 * 60 * 1000;
function dedupeKeys(ctx, p, now = Date.now()) {
  const body = String(p.text || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const make = (bucket) => crypto.createHash('sha256').update(`${ctx.schoolId}|${ctx.user._id}|${p.student?._id || ''}|${body}|${bucket}`).digest('hex');
  const bucket = Math.floor(now / WINDOW_MS);
  return [make(bucket), make(bucket - 1)];
}
const textKeyOf = (ctx, p) => crypto.createHash('sha256').update(`${ctx.schoolId}|${ctx.user._id}|${p.student?._id || ''}|${String(p.text || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()}`).digest('hex');
// A ticket of this person with these exact words whose creation could not be confirmed is still "the" ticket, however long ago: sending it again must not create another.
const findUnconfirmed = (ctx, p) => AssistantTicket.findOne({ school: ctx.schoolId, raisedBy: ctx.user._id, textKey: textKeyOf(ctx, p), 'verification.state': 'unverified', status: { $ne: 'resolved' } });
const findByKeys = (ctx, keys) => AssistantTicket.findOne({ school: ctx.schoolId, raisedBy: ctx.user._id, dedupeKey: { $in: keys } });

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

const flagLine = (ticket) => (ticket.modelSafety && !ticket.modelSafety.corroborated
  ? ` Note: the assistant's reading suggested a possible ${String(ticket.modelSafety.category).replace('_', ' ')} concern, but nothing in the message confirmed it${ticket.modelSafety.injected ? ' and the message contained instructions aimed at the assistant (ignored)' : ''}. Please review.` : '');
const staffMessage = (ctx, ticket, lead) => clip(`${lead} ${ticket.summary || ''}${ticket.requestedAction ? ` Requested: ${ticket.requestedAction}` : ''}${flagLine(ticket)} Raised by ${ctx.user.name} (${ctx.role}). Open EduAmigo Ask > Requests to reply.`, 1900);
const titleOf = (ticket, prefix = '') => clip(`${ticket.priority === 'high' ? 'Urgent: ' : ''}${prefix}${ticket.number} ${ticket.title || 'EduAmigo Ask ticket'}`, 190);

async function persistNotifications(ticket, results) {
  await AssistantTicket.updateOne({ _id: ticket._id, school: ticket.school }, { $push: { notifications: { $each: results.map((r) => ({ name: r.name, ok: r.ok, error: r.error || undefined })) } } });
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
      const keys = dedupeKeys(ctx, p);
      // The same report a moment ago (or at the same moment): hand back that ticket, create nothing, notify nobody twice.
      const already = (await findByKeys(ctx, keys)) || (await findUnconfirmed(ctx, p));
      if (already) {
        // An earlier attempt left this ticket with nobody to read it. If someone can be reached now, finish the job instead of leaving it stranded.
        if (already.verification?.state === 'unverified' && !(already.assignees || []).length) {
          const { people } = await recipientsFor({ school: ctx.schoolId, domain: already.domain, student: p.student, subject: p.subject, personName: p.personName, priority: already.priority });
          const reachable = people.filter((x) => x.userId);
          if (reachable.length) {
            await AssistantTicket.updateOne({ _id: already._id, school: ctx.schoolId }, { $set: { assignees: [...new Set(reachable.map((x) => x.userId))], contacts: people.map((x) => ({ name: x.name, title: x.title })), lastActivityAt: new Date() } });
            const healed = await AssistantTicket.findOne({ _id: already._id, school: ctx.schoolId });
            const notified = await tell(ctx, healed, reachable, { title: titleOf(healed), message: staffMessage(ctx, healed, `${REASON_TITLES[healed.reason] || 'Request'}.`) });
            await persistNotifications(healed, notified);
            return { ticket: healed, people, notified, deduped: true, healed: true, priority: healed.priority };
          }
        }
        return { ticket: already, people: [], notified: [], deduped: true, priority: already.priority };
      }

      let decided = policy.priorityFor({ safety: p.safety, severeWords: p.severeWords, text: p.text });
      // The model said "safety concern" but the words alone do not show it: one separate check that must quote the person's own words.
      if (decided.modelAsserted && !decided.modelAsserted.corroborated && ctx.aiAllowed !== false) {
        const check = await policy.confirmWithQuote(decided.modelAsserted.category, p.text);
        if (check.ai) ctx.noteAi?.(check.ai);
        if (check.quote) decided = policy.priorityFor({ safety: p.safety, severeWords: p.severeWords, text: p.text, quote: check.quote });
      }
      const { priority, reason: priorityReason, modelAsserted } = decided;
      // A ticket that is not urgent by policy is not described as urgent, whatever the model's label said.
      const reason = p.reason === 'sensitive' && priority !== 'high' ? 'complaint' : p.reason;
      const { team, people } = await recipientsFor({ school: ctx.schoolId, domain: p.domain, student: p.student, subject: p.subject, personName: p.personName, priority });
      const b = brief(ctx, { ...p, reason });
      const seq = await Counter.next(ctx.schoolId, 'assistantTicket');
      let ticket;
      try {
        ticket = await AssistantTicket.create({
          school: ctx.schoolId, number: `T-${1000 + seq}`, raisedBy: ctx.user._id, raisedRole: ctx.role, student: p.student?._id || null, domain: p.domain || null,
          question: redact(p.text).slice(0, 1000), ...b, entities: { student: p.student ? { name: p.student.name, class: `${p.student.class}-${p.student.section}` } : null, subject: p.subject || null, person: p.personName || null, domain: p.domain || null },
          reason, priority, priorityReason, modelSafety: modelAsserted, team, assignees: [...new Set(people.map((x) => x.userId).filter(Boolean))],
          contacts: people.map((x) => ({ name: x.name, title: x.title })), lastActivityAt: new Date(), dedupeKey: keys[0], textKey: textKeyOf(ctx, p),
        });
      } catch (err) {
        // Lost the race to an identical request: that request's ticket is the one.
        if (err?.code === 11000) {
          const winner = await findByKeys(ctx, keys);
          if (winner) return { ticket: winner, people: [], notified: [], deduped: true, priority: winner.priority };
        }
        throw err;
      }
      const notified = await tell(ctx, ticket, people, { title: titleOf(ticket), message: staffMessage(ctx, ticket, `${REASON_TITLES[reason] || 'Request'}.`) });
      await persistNotifications(ticket, notified);
      return { ticket, people, notified, team: teamLabel(team), priority };
    },
    // If creating failed part-way, look for the ticket before saying anything: it may have been saved.
    async recover(ctx, p) {
      const found = (await findByKeys(ctx, dedupeKeys(ctx, p))) || (await findUnconfirmed(ctx, p));
      return found ? { ticket: found, people: [], notified: [], priority: found.priority } : null;
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
      await AssistantTicket.updateOne({ _id: p.ticket._id, school: ctx.schoolId }, { $push: { notes: { by: ctx.user._id, kind: 'follow_up', text: redact(note) } }, $set: { lastActivityAt: new Date() } });
      const fresh = await AssistantTicket.findOne({ _id: p.ticket._id, school: ctx.schoolId });
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
    requires: 'the ticket was raised by this person and is still open',
    params: { ticket: 'the existing ticket', text: 'the new message' },
    // A resolved ticket is not an active one: the same problem coming back is a reopening, not a repeat.
    authorize: (ctx, p) => (isOwner(ctx, p.ticket) ? (p.ticket.status === 'resolved' ? { ok: false, why: 'resolved' } : { ok: true }) : { ok: false, why: 'not_yours' }),
    validate: (p) => [!p.text && 'text'].filter(Boolean),
    async execute(ctx, p) {
      await AssistantTicket.updateOne({ _id: p.ticket._id, school: ctx.schoolId }, { $push: { notes: { by: ctx.user._id, kind: 'repeat', text: redact(clip(p.text, 400)) } } });
      const fresh = await AssistantTicket.findOne({ _id: p.ticket._id, school: ctx.schoolId });
      const waitedH = (Date.now() - new Date(p.ticket.lastActivityAt || p.ticket.createdAt).getTime()) / 3600000;
      let notified = [];
      // Nudge only after a day without any activity, so asking twice in a minute does not flood staff.
      if (waitedH >= 24) {
        notified = await tell(ctx, fresh, fresh.assignees.map((id, i) => ({ name: fresh.contacts[i]?.name || 'Staff', userId: String(id) })), { title: titleOf(fresh, 'Reminder: '), message: clip(`${ctx.user.name} is still waiting for a reply on ${fresh.number} (${Math.round(waitedH / 24)} days).`, 1900) });
        await persistNotifications(fresh, notified);
        await AssistantTicket.updateOne({ _id: fresh._id, school: ctx.schoolId }, { $set: { lastActivityAt: new Date() } });
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
      await AssistantTicket.updateOne({ _id: p.ticket._id, school: ctx.schoolId }, {
        $set: { priority, priorityReason: reason, lastActivityAt: new Date() },
        $addToSet: { assignees: { $each: add.map((a) => a.userId) } },
        $push: { notes: { by: ctx.user._id, kind: 'escalation', text: redact(clip(p.text || 'The person asked for this to be escalated.', 400)) }, contacts: { $each: add.map((a) => ({ name: a.name, title: 'School office' })) } },
      });
      const fresh = await AssistantTicket.findOne({ _id: p.ticket._id, school: ctx.schoolId });
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
      await AssistantTicket.updateOne({ _id: p.ticket._id, school: ctx.schoolId }, {
        $set: { status: 'open', resolvedAt: null, lastActivityAt: new Date() }, $inc: { reopenedCount: 1 },
        $push: { notes: { by: ctx.user._id, kind: 'reopen', text: redact(clip(p.text || 'The person says the problem is not solved.', 400)) } },
      });
      const fresh = await AssistantTicket.findOne({ _id: p.ticket._id, school: ctx.schoolId });
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
