// EduAmigo Ask engine: one message in, one or more replies out.
//
//  1. Guard        the caller is signed in (route), AI quota decides whether the model may be used
//  2. Choice       a tapped button (topic, child, class, teacher, hand-off) resumes the pending question
//  3. Safety       complaints, safety concerns and requests for a person become a ticket at once
//  4. Split        one message can hold several questions
//  5. Route        each question gets a topic and a confidence score (router.js)
//  6. Gate         answer (>= 0.75) / clarify (0.45 - 0.75) / topic menu with a hand-off option (< 0.45)
//  7. Access       the topic must be open to the role and part of the school's plan
//  8. Details      which child (parents), which student (staff naming one), which class or teacher
//  9. Skill        reads the records and returns an answer with sources and a screen link
// 10. Writer       Hindi / Hinglish wording by the model, accepted only if the numbers match
// 11. Log         query log (metrics, audit) and conversation memory for follow-ups

const AssistantConversation = require('../models/AssistantConversation');
const AssistantQuery = require('../models/AssistantQuery');
const Student = require('../models/Student');
const SchoolClass = require('../models/SchoolClass');
const { studentForUser, teacherForUser, childrenForParent, canAccessStudent } = require('../services/directory');
const { usageThisMonth, recordUsage } = require('../services/subscription');
const { parseClassKey } = require('../utils/classes');
const { DOMAINS, domainsForRole } = require('./domains');
const router = require('./router');
const { redact, detectLanguage, tokenize, normalize, closeEnough } = require('./text');
const { parseClass, pickChildren, looksLikeFollowUp } = require('./entities');
const { recipientsFor, teamLabel } = require('./handoff');
const actions = require('./actions');
const messages = require('./actions/messages');
const AssistantTicket = require('../models/AssistantTicket');
const planner = require('./planner');
const policy = require('./policy');
const conversation = require('./conversation');
const { createTrace } = require('./trace');
const writer = require('./writer');
const { compose } = require('./compose');
const { today: dayKey, day: dayText } = require('./skills/util');
const llm = require('./llm');
const skills = require('./skills');
const { suggestionsFor } = require('./skills/general');
const { escapeRegex } = require('./skills/util');

const MAX_MESSAGE = 500;
const MAX_QUESTIONS = 4;
const AI_METRIC = 'assistant_ai';

const opt = (label, value, type) => ({ label, value: String(value), type });
// Choice buttons use the same words as the clarifying question ("Students' leave requests").
const domainOpt = (d) => opt(DOMAINS[d].ask.charAt(0).toUpperCase() + DOMAINS[d].ask.slice(1), d, 'domain');
const HANDOFF_OPTION = opt('Ask the school office', 'office', 'handoff');

// Words that never name a student (used when staff mention a student by name).
const NOT_NAMES = new Set([
  ...Object.values(DOMAINS).flatMap((d) => d.terms.flatMap(([p]) => tokenize(p))),
  'today', 'tomorrow', 'yesterday', 'aaj', 'kal', 'parso', 'class', 'section', 'school', 'student', 'students', 'teacher', 'teachers',
  'what', 'which', 'when', 'where', 'show', 'tell', 'give', 'list', 'please', 'month', 'week', 'year', 'mahine', 'hafte', 'pending', 'today',
  'kitni', 'kitna', 'kitne', 'batao', 'dikhao', 'kaise', 'kaun', 'kaunsa', 'kaunsi', 'meri', 'mera', 'mere', 'uski', 'uska', 'unki', 'hamara',
  'with', 'have', 'from', 'this', 'that', 'there', 'their', 'about', 'details', 'status', 'report', 'summary', 'total', 'all', 'sabhi', 'wala', 'wali',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'last', 'next', 'first', 'chahiye', 'hai', 'hain', 'tha', 'thi',
]);

const ageOf = (dob, now = new Date()) => (dob ? Math.floor((now - new Date(dob)) / (365.25 * 86400000)) : null);
const childSummary = (c) => ({ name: c.name, gender: c.gender ? (c.gender === 'Male' ? 'boy' : c.gender === 'Female' ? 'girl' : null) : null, age: ageOf(c.dateOfBirth), class: `class ${c.class}-${c.section}` });

function emptyPending() {
  return { text: null, kind: null, domain: null, subject: null, person: null, child: null, summary: null, options: [], attempts: 0 };
}

async function loadConversation(user, schoolId, conversationId) {
  if (conversationId) {
    const conv = await AssistantConversation.findOne({ _id: conversationId, user: user._id, school: schoolId }).catch(() => null);
    if (conv) return conv;
  }
  return AssistantConversation.create({ school: schoolId, user: user._id });
}

// Lazily loaded profile of the asker.
function profileLoader(user) {
  const cache = {};
  return {
    async student() { if (!('student' in cache)) cache.student = await studentForUser(user); return cache.student; },
    async children() { if (!('children' in cache)) cache.children = await childrenForParent(user); return cache.children; },
    async teacher() { if (!('teacher' in cache)) cache.teacher = await teacherForUser(user); return cache.teacher; },
  };
}

// Students named in a staff member's question. Teachers only see students they teach.
async function namedStudents(ctx, text) {
  const words = [...new Set(tokenize(text).filter((w) => w.length >= 3 && /^[a-z]+$/.test(w) && !NOT_NAMES.has(w)))];
  if (!words.length) return [];
  const found = await Student.find({ school: ctx.schoolId, isActive: true, name: { $regex: `(^|\\s)(${words.map(escapeRegex).join('|')})(\\s|$)`, $options: 'i' } }).limit(6);
  const visible = [];
  for (const s of found) if (await canAccessStudent(ctx.user, s)) visible.push(s);
  // "Kabir Sharma" matches every Sharma; the student whose name has the most of the written words is the one meant.
  const score = (s) => tokenize(s.name).filter((w) => words.some((x) => x === w)).length;
  const best = Math.max(0, ...visible.map(score));
  return visible.filter((s) => score(s) === best);
}

// Class choices for "which class?" questions.
async function classOptions(ctx) {
  if (ctx.role === 'teacher' && ctx.teacher) {
    return (ctx.teacher.assignedClasses || []).slice(0, 8).map((c) => { const k = parseClassKey(c); return opt(`${k.class}${k.section ? `-${k.section}` : ''}`, `${k.class}-${k.section}`, 'class'); });
  }
  const masters = await SchoolClass.find({ school: ctx.schoolId, isActive: true }).sort({ order: 1 }).lean();
  const keys = masters.flatMap((m) => (m.sections?.length ? m.sections.map((s) => `${m.name}-${s.name}`) : [m.name]));
  if (keys.length) return keys.slice(0, 8).map((k) => opt(k, k, 'class'));
  const groups = await Student.aggregate([{ $match: { school: ctx.schoolId, isActive: true } }, { $group: { _id: { c: '$class', s: '$section' } } }, { $sort: { '_id.c': 1, '_id.s': 1 } }, { $limit: 8 }]);
  return groups.map((g) => opt(`${g._id.c}-${g._id.s}`, `${g._id.c}-${g._id.s}`, 'class'));
}

function reply(base) {
  return {
    domain: null, label: null, confidence: 0, method: 'keywords', action: 'answer', text: '', sources: [], link: null, actions: [], options: [], ticket: null,
    ...base,
  };
}

// "Mrs. Sunita Sharma (Maths teacher)" for the people a ticket went to, school management left out.
function sentToText(ticket) {
  const named = (ticket.contacts || []).filter((c) => c.title !== 'School office' || (ticket.contacts || []).length === 1);
  const people = named.slice(0, 2).map((c) => (c.title && c.title !== 'School office' ? `${c.name} (${c.title})` : c.name));
  if (!people.length) return teamLabel(ticket.team).toLowerCase();
  return people.join(' and ');
}

// A message that needs a person (complaint, request to speak with staff, a question only a person can answer, a safety concern).
// UnifiedAI does not blindly open a ticket: the planner checks the person's existing tickets and picks the action that fits
// (new ticket, follow-up on an open one, repeat of the same issue, escalate, reopen). The action is run through its contract
// and the reply is built from what was VERIFIED, so it never claims a success that did not happen.
async function ticketReply({ ctx, text, domain, reason, student, subject = null, personName = null, part = null, severeWords = false, brief = null }) {
  let tickets = await ctx.tickets();
  // A ticket number the person typed (the one in their message, if it names exactly one) wins over the model's reading; a number only the model named is used only if it is theirs.
  // Either way it is looked up directly by number and owner, so an old ticket is found and nobody else's ever is.
  const numbersIn = (s) => [...new Set((String(s || '').match(/\bT-\d{3,}\b/gi) || []).map((n) => n.toUpperCase()))];
  const inPart = numbersIn(text)[0];
  const inMessage = numbersIn(ctx.redacted);   // a message that names exactly one ticket names it for every part
  const explicit = inMessage.length === 1 ? inMessage[0] : inPart || null;
  const wanted = explicit || part?.ticket?.number || null;
  if (wanted && !tickets.some((t) => t.number.toLowerCase() === wanted.toLowerCase())) {
    const own = await ctx.tickets.byNumber(wanted);
    if (own) tickets = [...tickets, own];
    else if (explicit) {
      ctx.trace.step('plan', { action: 'none', lookup: 'not_found', explicit: true });
      return reply({
        domain: domain || null, label: domain ? DOMAINS[domain]?.label : null, confidence: 1, method: 'rule', action: 'blocked', question: text,   // someone else's and a missing ticket look the same, and count as a refusal, not as an unresolved question
        text: `I could not find a ticket ${explicit} among your requests. Please check the number under Requests, or tell me what it is about and I will help from there.`,
      });
    }
  }
  const planPart = explicit && part ? { ...part, ticket: { ...(part.ticket || {}), number: explicit } } : part;
  const plan = planner.plan(planPart || {}, { tickets, text, domain, student, personName, inChat: (ctx.conv.state.tickets || []).map((t) => t.number), now: ctx.now });
  ctx.trace.step('plan', { modelRelation: part?.ticket?.relation || null, modelTicket: part?.ticket?.number || null, action: plan.action, ticket: plan.ticket?.number || null, via: plan.via || null, openTickets: tickets.length, personNamed: !!personName, explicitNumber: !!explicit });
  // Asking about a complaint when there is nothing to look up is a plain question, not a refusal.
  if (plan.action === 'ticket.status' && !plan.ticket) {
    return reply({
      domain: domain || null, confidence: 1, method: 'rule', action: 'answer', question: text,
      text: 'You have not raised any request through me yet, so there is nothing to check. If something is wrong, tell me what happened and I will pass it to the right person.',
    });
  }
  const params = {
    text, domain, reason, student, subject, personName, severeWords, brief: brief || part?.brief || null, safety: part?.safety || (severeWords ? 'safety' : 'none'),
    ticket: plan.ticket?.raw || null,
  };
  const result = await actions.run(plan.action, ctx, params);
  const said = messages.describe(plan, result, { reason, now: ctx.now });
  ctx.actionLog.push({ name: plan.action, state: result.state, failed: result.failed || [], outcome: said.kind, ok: result.ok, verified: result.verified, ticket: result.data?.ticket?.number || plan.ticket?.number || null });
  await recordVerification(result);
  if (result.ok && plan.action === 'ticket.create') ctx.tickets.created(result.data.ticket.number);
  // Whatever might have changed (even if it could not be confirmed) is read again next time.
  if (['verified', 'unverified', 'error'].includes(result.state) && plan.action !== 'ticket.status') ctx.tickets.refresh();

  // Only a confirmed "nothing happened" offers a retry. If it may have happened, the person is sent to Requests instead, so a retry cannot double it.
  const failed = said.kind === 'failed';
  const uncertain = said.kind === 'uncertain';
  if (failed) ctx.setPending({ text, kind: 'handoff', domain, subject, person: personName, child: student?.name || null, summary: part?.english || null, options: [opt('Try again', 'office', 'handoff')] });
  return reply({
    domain: domain || null, label: domain ? DOMAINS[domain]?.label : null, confidence: 1, method: 'rule',
    action: failed || uncertain ? 'no_data' : said.kind === 'blocked' ? 'blocked' : said.kind === 'status' ? 'answer' : 'handoff',
    text: said.text, question: text, options: failed ? [opt('Try again', 'office', 'handoff')] : [],
    ticket: messages.ticketPayload(plan, result, said.kind),
    ...(said.kind === 'status' && result.data?.ticket ? {
      facts: { ticket: { number: result.data.ticket.number, status: result.data.ticket.status, priority: result.data.ticket.priority, sentTo: (result.data.ticket.contacts || []).map((c) => c.name) } },
      sources: [{ type: 'ticket', label: `Request ${result.data.ticket.number}`, id: String(result.data.ticket._id), at: new Date(result.data.ticket.lastActivityAt || result.data.ticket.updatedAt).toISOString() }],
    } : {}),
  });
}


// An action that ran but could not be read back leaves a mark on the ticket for staff ("needs review"), so a person or operator does
// not repeat it unknowingly; a later confirmed result clears the mark. Best effort: it must never break the reply.
async function recordVerification(result) {
  const t = result.data?.ticket;
  if (!t?._id) return;
  try {
    if (result.state === 'unverified') await AssistantTicket.updateOne({ _id: t._id, school: t.school }, { $set: { verification: { state: 'unverified', action: result.name, failed: result.failed || [], at: new Date() } } });
    else if (result.state === 'verified' && t.verification?.state === 'unverified') await AssistantTicket.updateOne({ _id: t._id, school: t.school }, { $unset: { verification: 1 } });
  } catch { /* the trace and the action log still record the state */ }
}

// One message, one issue, one ticket. A model may split "the marks are wrong and I want to talk to the Maths teacher" into two parts.
// Parts that need a person and are about the same topic, child and teacher are merged into one (the strongest reason and safety win).
const REASON_RANK = ['sensitive', 'complaint', 'requested', 'forwarded'];
const SAFETY_RANK = ['none', 'payment_dispute', 'medical', 'safety', 'harassment'];
const needsPerson = (p) => p.urgent || ['complaint', 'human', 'forward'].includes(p.kind);
const reasonOf = (p) => (p.urgent ? 'sensitive' : p.kind === 'complaint' ? 'complaint' : p.kind === 'forward' ? 'forwarded' : 'requested');

// Two parts are the same issue when nothing about them conflicts: the same topic (or one has none), the same child (or one is not
// named), the same teacher or subject (or one is not named).
const sameOrMissing = (a, b) => !a || !b || String(a).toLowerCase() === String(b).toLowerCase();
const topicOf = (p) => (DOMAINS[p.topic] && p.topic !== 'general' ? p.topic : null);
const sameIssue = (a, b) => sameOrMissing(topicOf(a), topicOf(b)) && sameOrMissing(a.child, b.child) && sameOrMissing(a.person, b.person) && sameOrMissing(a.subject, b.subject);

function mergePersonParts(parts) {
  const out = [];
  for (const part of parts) {
    if (!needsPerson(part)) { out.push(part); continue; }
    const first = out.find((o) => o._reason && sameIssue(o, part));
    if (!first) { out.push({ ...part, _reason: reasonOf(part) }); continue; }
    first.text = `${first.text}. ${part.text}`.slice(0, 400);
    if (REASON_RANK.indexOf(reasonOf(part)) < REASON_RANK.indexOf(first._reason)) first._reason = reasonOf(part);
    if (SAFETY_RANK.indexOf(part.safety) > SAFETY_RANK.indexOf(first.safety)) { first.safety = part.safety; first.urgent = part.urgent; }
    first.brief = first.brief || part.brief;
    first.ticket = first.ticket || part.ticket;
    first.topic = topicOf(first) ? first.topic : part.topic;
    first.person = first.person || part.person; first.subject = first.subject || part.subject; first.child = first.child || part.child;
  }
  return out;
}

// The hand-off button, naming the person when one is known ("Ask Mrs. Sunita Sharma").
async function handoffOffer(ctx, { text, domain = null, subject = null, person = null, child = null }) {
  const student = await studentForHandoff(ctx, text, child);
  const { people } = await recipientsFor({ school: ctx.schoolId, domain, student, subject, personName: person });
  const first = people.find((p) => p.title !== 'School office' && p.title !== 'Accounts office');
  const label = first ? `Ask ${first.name}` : domain && DOMAINS[domain]?.owner === 'accounts' ? 'Ask the accounts office' : 'Ask the school office';
  return { option: opt(label, 'office', 'handoff'), who: first ? `${first.name} (${first.title})` : null };
}

function complaintInquiryReply(ctx, text) {
  // The app keeps no complaint or remark records. Say so and offer to ask the office; a ticket is only
  // created if the person agrees.
  ctx.setPending({ text, kind: 'handoff', domain: null, options: [HANDOFF_OPTION] });
  return reply({
    domain: 'general', label: DOMAINS.general.label, confidence: 1, method: 'rule', action: 'no_data', options: [HANDOFF_OPTION],
    text: 'I cannot see any complaints or remarks from the school here. Would you like me to ask the school office if anything has been noted for you?',
  });
}

// The student a hand-off is about: the asker (students), or the child named or the only child (parents).
async function studentForHandoff(ctx, text, child = null) {
  if (ctx.role === 'student') return ctx.profile.student();
  if (ctx.role === 'parent') {
    const kids = await ctx.profile.children();
    const named = child && kids.find((c) => c.name.toLowerCase() === child.toLowerCase());
    if (named) return named;
    return pickChildren(text, kids, ctx.conv.state.lastStudentId)[0] || (kids.length === 1 ? kids[0] : null);
  }
  return null;
}

// Records that belong to one person: asking for someone else's (another student, a whole school) is refused, never answered
// from the asker's own record.
const PERSONAL_RECORDS = ['fees', 'attendance', 'exams', 'leave'];

// Does the question name a student of this school who is not the asker's own (or child)?
async function namesOtherStudent(ctx, text, own) {
  const words = [...new Set(tokenize(text).filter((w) => w.length >= 3 && /^[a-z]+$/.test(w) && !NOT_NAMES.has(w)))];
  if (!words.length) return false;
  const found = await Student.find({ school: ctx.schoolId, isActive: true, name: { $regex: `(^|\\s)(${words.map(escapeRegex).join('|')})(\\s|$)`, $options: 'i' } }).select('_id').limit(6).lean();
  const ownIds = new Set(own.map((s) => String(s._id)));
  return found.length > 0 && !found.some((s) => ownIds.has(String(s._id)));
}

// Returns the refusal text, or null when the question stays within what the asker may see.
async function scopeRefusal(ctx, d, text, nlu, forced) {
  if (forced.studentIds) return null; // a tapped choice; the options were the asker's own
  // Exam dates, like the timetable, are the same for the whole class: not a personal record.
  if (d === 'exams' && nlu?.view === 'schedule') return null;
  if (['student', 'parent'].includes(ctx.role) && PERSONAL_RECORDS.includes(d)) {
    const own = ctx.role === 'student' ? [await ctx.profile.student()].filter(Boolean) : await ctx.profile.children();
    const namesOwn = ctx.role === 'parent' && pickChildren(text, own, ctx.conv.state.lastStudentId).length > 0;
    const aboutOthers = ['other', 'everyone'].includes(nlu?.about) && !namesOwn;
    if (aboutOthers || await namesOtherStudent(ctx, text, own)) {
      return ctx.role === 'parent'
        ? 'I can only share details about your own children here, so I cannot help with another student or with the whole school. If you need something about your children, just ask.'
        : 'I can only share your own records here, so I cannot help with another student or with the whole school. If you need something about yourself, just ask.';
    }
  }
  if (ctx.role === 'teacher' && d === 'hr' && ['other', 'everyone'].includes(nlu?.about)) {
    return 'I can only share your own salary and leave details here. For anyone else, please speak to the school office.';
  }
  return null;
}

// One question -> one reply. `forced` comes from a tapped choice: { domain, studentIds, cls, staffId }.
async function answerQuestion(ctx, text, forced = {}) {
  const out = await answerQuestionInner(ctx, text, forced);
  return { ...out, question: text };
}

async function answerQuestionInner(ctx, text, forced = {}) {
  const state = ctx.conv.state;
  // "Has any complaint come from school for me?" (found by the model, or by words when there is no model).
  if (!forced.domain && (forced.nlu?.kind === 'complaint_inquiry' || (!forced.nlu && router.isComplaintInquiry(text)))) {
    return complaintInquiryReply(ctx, text);
  }
  let r;
  if (forced.nlu) {
    // The model already read this question: its topic and confidence go through the same gate as keyword routing.
    r = { ...router.reconcile({ ...forced.nlu, text }, ctx.allowed), sensitive: forced.nlu.urgent };
  } else if (forced.domain) r = { domain: forced.domain, confidence: 1, method: 'choice', runnerUp: null };
  else {
    r = await router.route(text, { role: ctx.role, allowed: ctx.allowed, previousTopic: state.lastDomain, useModel: ctx.aiAllowed });
    if (r.model) ctx.noteAi(r.model);
    // Follow-ups ("aur Ananya ki?", "uski attendance?") keep the previous topic.
    const namesChild = ctx.role === 'parent' && pickChildren(text, await ctx.profile.children(), state.lastStudentId).length > 0;
    if (state.lastDomain && state.lastDomain !== 'general' && (!r.domain || r.domain === 'general' || r.confidence < router.CLARIFY_AT)
      && (looksLikeFollowUp(text) || namesChild)) {
      r = { domain: state.lastDomain, confidence: 0.8, method: 'context', runnerUp: null };
    }
  }

  // The model picked a topic this person cannot use (a parent's "pocket money" read as payroll):
  // treat it as a school question for the office rather than offering a topic they cannot open.
  if (r.method === 'model' && DOMAINS[r.domain] && r.domain !== 'general' && !ctx.allowed.includes(r.domain) && !router.wordsNameTopic(text, r.domain)) {
    r = { ...r, domain: 'school_other' };
  }

  // Safety flagged by the model.
  if (r.sensitive) return ticketReply({ ctx, text, domain: r.domain === 'school_other' ? null : r.domain, reason: 'sensitive', student: await studentForHandoff(ctx, text), part: forced.nlu || null });

  // A school question no topic covers: offer the office.
  if (r.domain === 'school_other') {
    ctx.setPending({ text, kind: 'handoff', domain: null, summary: forced.nlu?.english || null, options: [HANDOFF_OPTION] });
    return reply({ confidence: r.confidence, method: r.method, action: 'no_data', text: 'I do not have that detail with me. Would you like me to ask the school office for you?', options: [HANDOFF_OPTION] });
  }

  // Nothing recognised: a general answer from the model when one is available, otherwise say what the
  // assistant can do and offer to pass the question to the school office.
  if (!r.domain) {
    const out = await skills.general.run({ ...ctx, text });
    if (out.ai) ctx.noteAi(out.ai);
    if (out.generated) {
      return reply({ domain: 'general', label: DOMAINS.general.label, confidence: 0, method: r.method, action: 'answer', text: out.text, options: out.options || [], generated: true });
    }
    const options = [...(out.options || []).slice(0, 4), HANDOFF_OPTION];
    ctx.setPending({ text, kind: 'handoff', domain: null, options });
    return reply({ domain: 'general', label: DOMAINS.general.label, confidence: 0, method: r.method, action: 'clarify', text: out.text, options });
  }

  // Confidence gate.
  if (r.confidence < router.ANSWER_AT) {
    const attempts = (state.pending?.text ? state.pending.attempts : 0) + 1;
    if (attempts > 2) return ticketReply({ ctx, text, domain: r.domain, reason: 'unclear', student: await studentForHandoff(ctx, text) });
    let options;
    let question;
    if (r.confidence >= router.CLARIFY_AT && r.runnerUp && ctx.allowed.includes(r.runnerUp)) {
      options = [domainOpt(r.domain), domainOpt(r.runnerUp)];
      question = `Just to be sure, is this about ${DOMAINS[r.domain].ask} or ${DOMAINS[r.runnerUp].ask}?`;
    } else if (r.confidence >= router.CLARIFY_AT) {
      options = [domainOpt(r.domain)];
      question = `Is this about ${DOMAINS[r.domain].ask}?`;
    } else {
      const likely = [r.domain, r.runnerUp, ...ctx.allowed].filter((d, i, a) => d && d !== 'general' && ctx.allowed.includes(d) && a.indexOf(d) === i).slice(0, 4);
      options = likely.map(domainOpt);
      question = 'I want to get this right. Which of these is it about?';
    }
    options.push(opt('Something else', 'office', 'handoff'));
    ctx.setPending({ text, kind: 'domain', domain: r.domain, options, attempts });
    return reply({ domain: r.domain, label: DOMAINS[r.domain].label, confidence: r.confidence, method: r.method, runnerUp: r.runnerUp, action: 'clarify', text: question, options });
  }

  const d = r.domain;
  ctx.trace.step('route', { domain: d, confidence: r.confidence, method: r.method, runnerUp: r.runnerUp || null });
  const base = { domain: d, label: DOMAINS[d].label, confidence: r.confidence, method: r.method, runnerUp: r.runnerUp || null };

  // Access: role, then plan.
  if (!DOMAINS[d].roles.includes(ctx.role)) {
    return reply({ ...base, action: 'blocked', text: `Sorry, ${DOMAINS[d].label.toLowerCase()} details are not available for your account.` });
  }
  if (DOMAINS[d].feature && !ctx.entitlements?.features?.includes(DOMAINS[d].feature)) {
    return reply({ ...base, action: 'blocked', text: `${DOMAINS[d].label} is not switched on for ${ctx.school?.name || 'your school'} yet, so I cannot help with it here.` });
  }

  const skill = skills[d];
  const nluClass = forced.nlu?.class ? parseClass(`class ${forced.nlu.class}`) : null;
  // The model's plain-English restatement goes first, so a date word like "kal" is read the way the model understood the sentence.
  const understood = forced.nlu?.english ? `${forced.nlu.english} ${text}` : text;
  const sctx = {
    ...ctx, text: understood, question: text, cls: forced.cls || parseClass(text) || nluClass, staffId: forced.staffId || null,
    personName: forced.nlu?.person || null, subject: forced.nlu?.subject || null, child: forced.nlu?.child || null, view: forced.nlu?.view || null, search: forced.nlu?.search || null, students: [],
  };
  const refusal = await scopeRefusal(ctx, d, text, forced.nlu, forced);
  if (refusal) return reply({ ...base, action: 'blocked', text: refusal });
  if (d === 'general') {
    const out = await skill.run(sctx);
    if (out.ai) ctx.noteAi(out.ai);
    return reply({ ...base, text: out.text, options: out.options || [], generated: !!out.generated });
  }

  // Which student(s).
  if (ctx.role === 'student') {
    const s = await ctx.profile.student();
    sctx.students = s ? [s] : [];
  } else if (ctx.role === 'parent') {
    const children = await ctx.profile.children();
    if (!skill.needsStudent) sctx.students = children;
    else if (forced.studentIds) sctx.students = forced.studentIds.includes('all') ? children : children.filter((c) => forced.studentIds.includes(String(c._id)));
    else {
      let chosen = pickChildren(text, children, state.lastStudentId);
      // The model matched the child from the sentence itself ("mere bete ki", "chhoti ka").
      if (!chosen.length && forced.nlu?.child) {
        // "all" is only believed when the words say so (both, dono, sab); a model that guesses "all" must not skip the question.
        const sayAll = pickChildren(text, children, state.lastStudentId).length === children.length;
        chosen = forced.nlu.child.toLowerCase() === 'all' ? (sayAll ? children : []) : children.filter((c) => c.name.toLowerCase() === forced.nlu.child.toLowerCase());
      }
      if (!chosen.length && children.length === 1) chosen = children;
      if (!chosen.length && state.lastStudentId) chosen = children.filter((c) => String(c._id) === String(state.lastStudentId));
      // Class-wide answers (timetable, exam dates) are the same for children in one class.
      if (!chosen.length && children.length > 1 && skill.classLevel?.(sctx) && new Set(children.map((c) => `${c.class}-${c.section}`)).size === 1) chosen = [children[0]];
      if (!chosen.length && children.length > 1) {
        const options = [...children.map((c) => opt(`${c.name} (${c.class}-${c.section})`, c._id, 'student')), opt('All children', 'all', 'student')];
        ctx.setPending({ text, kind: 'student', domain: d, options, attempts: 1 });
        return reply({ ...base, action: 'clarify', text: `Happy to help. Which of your children is this about?`, options });
      }
      sctx.students = chosen;
    }
  } else if (skill.staffCanName && !forced.cls) {
    if (forced.studentIds) {
      const s = await Student.find({ _id: { $in: forced.studentIds }, school: ctx.schoolId });
      sctx.students = [];
      for (const x of s) if (await canAccessStudent(ctx.user, x)) sctx.students.push(x);
    } else if (!sctx.cls && !sctx.personName) {
      const named = await namedStudents(sctx, text);
      if (named.length === 1) sctx.students = named;
      else if (named.length > 1) {
        const options = named.slice(0, 5).map((s) => opt(`${s.name} (${s.class}-${s.section})`, s._id, 'student'));
        ctx.setPending({ text, kind: 'student', domain: d, options, attempts: 1 });
        return reply({ ...base, action: 'clarify', text: 'Which student do you mean?', options });
      }
    }
  }

  const out = await skill.run(sctx);
  if (out.need) {
    const options = out.need.options || (out.need.kind === 'class' ? await classOptions(sctx) : []);
    ctx.setPending({ text, kind: out.need.kind, domain: d, options, attempts: 1 });
    return reply({ ...base, action: 'clarify', text: out.need.question, options });
  }

  state.lastDomain = d;
  if (sctx.students.length === 1) state.lastStudentId = sctx.students[0]._id;
  if (sctx.cls) state.lastClass = `${sctx.cls.class}-${sctx.cls.section}`;

  if (out.blocked) return reply({ ...base, action: 'blocked', text: out.text });
  if (out.noData) {
    let offer = null;
    if (out.handoffOffer) {
      offer = await handoffOffer(ctx, { text, domain: d, subject: sctx.subject, person: sctx.personName, child: sctx.child });
      ctx.setPending({ text, kind: 'handoff', domain: d, subject: sctx.subject, person: sctx.personName, child: sctx.child, summary: forced.nlu?.english || null, options: [offer.option] });
    }
    return reply({ ...base, action: 'no_data', text: out.text, link: out.link || null, options: offer ? [offer.option] : [] });
  }
  // Every data answer names what it was read from, including "nothing found" answers.
  const sources = out.sources?.length ? out.sources : [{ type: d, label: `${DOMAINS[d].label} records checked` }];
  return reply({
    ...base, action: 'answer', text: out.text, sources, link: out.link || null, actions: out.actions || [], options: out.options || [],
    facts: out.facts && Object.keys(out.facts).length ? out.facts : null, subject: sctx.subject, person: sctx.personName, child: sctx.child, summary: forced.nlu?.english || null,
  });
}

// Matches free text to a pending option ("Aditya", "fees", "8-B").
function matchOption(text, options) {
  const t = normalize(text);
  if (!t) return null;
  return options.find((o) => normalize(o.label) === t || normalize(o.value) === t
    || tokenize(o.label).some((w) => w.length >= 3 && tokenize(t).length <= 3 && tokenize(t).some((x) => closeEnough(x, w)))) || null;
}

// Main entry. Returns { conversationId, queryId, language, replies, suggestions }.
async function ask({ user, school, entitlements, message, conversationId, choice, now = new Date() }) {
  const started = Date.now();
  const schoolId = school._id;
  const trace = createTrace({ role: user.role });
  const conv = await loadConversation(user, schoolId, conversationId);
  const pending = conv.state?.pending?.text ? JSON.parse(JSON.stringify(conv.state.pending)) : null;
  let text = String(message || '').trim().slice(0, MAX_MESSAGE);

  const allowance = entitlements?.limits?.aiQuestionsPerMonth;
  const aiAllowed = llm.available() && (allowance == null || (await usageThisMonth(schoolId, AI_METRIC)) < allowance);
  const aiInfo = { used: false, provider: null, model: null, inputTokens: 0, outputTokens: 0, rewritten: false, composed: false };
  const ctx = {
    user, role: user.role, school, schoolId, entitlements, now, conv, aiAllowed,
    allowed: domainsForRole(user.role),
    profile: profileLoader(user),
    noteAi(m) {
      if (!m || m.cached) return;
      aiInfo.used = true; aiInfo.provider = m.provider; aiInfo.model = m.model;
      aiInfo.inputTokens += m.usage?.input || 0; aiInfo.outputTokens += m.usage?.output || 0;
    },
    setPending(p) { this.newPending = { ...emptyPending(), ...p }; },
    newPending: null,
    trace,
    actionLog: [],
  };
  // The person's own recent tickets, loaded once per request and again after an action changed them.
  let ticketCache = null;
  const madeNow = new Set();
  ctx.tickets = async () => {
    if (!ticketCache) {
      const list = await conversation.recentTickets(user, schoolId, now);
      // A ticket discussed in this chat stays in view even when newer ones push it out of the recent few.
      for (const n of (conv.state.tickets || []).map((t) => t.number)) {
        if (list.some((t) => t.number === n)) continue;
        const own = await conversation.ticketByNumber(user, schoolId, n);
        if (own) list.push(own);
      }
      ticketCache = list.map((t) => ({ ...t, freshInRequest: madeNow.has(t.number) }));
    }
    return ticketCache;
  };
  // A ticket the person names by number, of any age; only theirs. Null when it does not exist or is someone else's (the same answer).
  ctx.tickets.byNumber = (number) => conversation.ticketByNumber(user, schoolId, number);
  ctx.tickets.refresh = () => { ticketCache = null; };
  ctx.tickets.created = (number) => madeNow.add(number);
  if (ctx.role === 'teacher') ctx.teacher = await ctx.profile.teacher();

  // A suggestion chip is just a question.
  if (choice?.type === 'ask' && choice.value) text = String(choice.value).slice(0, MAX_MESSAGE);
  // Free text that answers a pending question counts as tapping that option.
  let tapped = choice && choice.type !== 'ask' ? choice : null;
  if (!tapped && pending && text) {
    const m = matchOption(text, pending.options || []);
    if (m) tapped = { type: m.type, value: m.value };
  }
  if (!text && !tapped) {
    const err = new Error('Please type a question'); err.status = 400; err.expose = true; throw err;
  }
  ctx.redacted = redact(text || pending?.text || '');
  let language = detectLanguage(text || pending?.text || '');
  ctx.language = language;

  const replies = [];
  const shown = text || tapped?.label || '';

  if (tapped && pending) {
    const forced = {};
    if (tapped.type === 'handoff') {
      replies.push(await ticketReply({
        ctx, text: pending.text, domain: pending.domain, reason: pending.kind === 'handoff' ? (pending.subject || pending.person ? 'forwarded' : 'not_covered') : 'unclear',
        student: await studentForHandoff(ctx, pending.text, pending.child), subject: pending.subject, personName: pending.person,
        brief: pending.summary ? { title: null, summary: `${ctx.user.name} (${ctx.role}) asks: ${pending.summary}`, request: null } : null,
      }));
    } else {
      if (tapped.type === 'domain') forced.domain = tapped.value;
      else forced.domain = pending.domain;
      if (tapped.type === 'student') forced.studentIds = [tapped.value];
      if (tapped.type === 'class') { const k = parseClassKey(tapped.value); forced.cls = { class: k.class, section: k.section }; }
      if (tapped.type === 'staff') forced.staffId = tapped.value;
      if (forced.domain && !DOMAINS[forced.domain]) forced.domain = null;
      const r = await answerQuestion(ctx, pending.text, forced);
      r.method = r.method === 'rule' ? 'rule' : 'choice';
      replies.push(r);
    }
  } else {
    // Safety words always go to a person at once, whatever a model would say.
    // Instructions aimed at the assistant are cut out first, so they can neither supply a safety word nor raise priority.
    const scan = policy.withoutDirectives(text).text;
    const severe = router.isSevere(scan);
    // Otherwise the model reads the message first; words are the fallback (no model, allowance used, call failed).
    const understood = !severe && ctx.aiAllowed
      ? await router.understand(text, {
        role: ctx.role, allowed: ctx.allowed, previousTopic: conv.state.lastDomain, context: conversation.contextFor(conv, await ctx.tickets(), now),
        children: ctx.role === 'parent' ? (await ctx.profile.children()).map(childSummary) : [],
      })
      : null;
    ctx.trace.step('understand', { provider: understood?.model?.provider || null, cached: !!understood?.model?.cached, parts: understood?.parts.length || 0, kinds: (understood?.parts || []).map((x) => x.kind), fallback: !understood && !severe, severeWords: !!severe }, !!understood || !!severe || !ctx.aiAllowed);
    if (understood) {
      ctx.noteAi(understood.model);
      // The model's reading of the language is better than word counts (short Hinglish looks like English).
      if (understood.language && language !== 'hi') { language = understood.language; ctx.language = language; }
      for (const part of mergePersonParts(understood.parts)) {
        const topicDomain = DOMAINS[part.topic] && part.topic !== 'general' ? part.topic : null;
        if (part.kind === 'ticket_status') {
          replies.push(await ticketReply({ ctx, text: part.text, domain: null, reason: 'requested', student: null, part }));
        } else if (part.urgent || ['complaint', 'human', 'forward'].includes(part.kind)) {
          const reason = part._reason || reasonOf(part);
          replies.push(await ticketReply({
            ctx, text: part.text, domain: topicDomain, reason, student: await studentForHandoff(ctx, part.text, part.child), subject: part.subject, personName: part.person, part,
          }));
        } else replies.push(await answerQuestion(ctx, part.text, { nlu: part }));
      }
    } else if (router.isTicketStatusQuestion(scan)) {
      // No model reading, and the message asks about an existing complaint or ticket: read the person's own ticket (the one they named,
      // else the one just discussed, else the newest). Weak words alone never create a ticket or add to one.
      replies.push(await ticketReply({ ctx, text, domain: null, reason: 'requested', student: null, part: { kind: 'ticket_status', ticket: null } }));
    } else if (severe || router.isSensitive(scan) || router.wantsHuman(scan)) {
      const scored = router.scoreKeywords(text, ctx.allowed);
      const domain = scored.domain && scored.domain !== 'general' ? scored.domain : (conv.state.lastDomain !== 'general' ? conv.state.lastDomain : null);
      const reason = severe ? 'sensitive' : router.isSensitive(scan) ? 'complaint' : 'requested';
      replies.push(await ticketReply({ ctx, text, domain, reason, student: await studentForHandoff(ctx, text), severeWords: !!severe }));
    } else {
      const questions = router.splitQuestions(text, ctx.allowed).slice(0, MAX_QUESTIONS);
      for (const q of questions) replies.push(await answerQuestion(ctx, q));
    }
  }

  // Each data answer is written for the exact question asked, in the person's language (facts, numbers and names checked);
  // the other replies (clarifying questions, hand-offs, blocks) are only put into the person's language.
  const composable = replies.map((r, i) => ({ id: String(i), r })).filter(({ r }) => r.action === 'answer' && r.facts && !r.generated);
  const wordable = replies.map((r, i) => ({ id: String(i), r })).filter(({ r }) => !composable.some((c) => c.r === r)
    && ['answer', 'no_data', 'blocked', 'clarify', 'handoff'].includes(r.action) && !r.generated && r.text);
  // Both model calls run at the same time, so the person waits for one.
  const [composed, worded] = await Promise.all([
    ctx.aiAllowed && composable.length
      ? compose(
        composable.map(({ id, r }) => ({ id, question: r.question, text: r.text, facts: r.facts })),
        { role: ctx.role, askerName: ctx.user?.name || '', language, today: `${dayText(dayKey(now), { weekday: true })}` },
      )
      : null,
    ctx.aiAllowed && writer.shouldRewrite() && wordable.length
      ? writer.rewrite(wordable.map(({ id, r }) => ({ id, text: r.text })), language)
      : null,
  ]);
  if (composed) {
    if (composed.ai) ctx.noteAi(composed.ai);
    for (const { id, r } of composable) {
      const w = composed.result.get(id);
      if (!w || w.rejected) { if (w?.rejected) { r.groundedCheck = 'kept_original'; r.composition = 'kept_original'; } continue; }
      if (w.text !== r.text) { r.text = w.text; r.composition = 'composed'; aiInfo.composed = true; }
      // Document answers cite only the passages the answer relied on.
      if (r.sources.some((x) => x.n)) {
        const used = r.sources.filter((x) => w.used?.includes(x.n));
        r.sources = (used.length ? used : r.sources.slice(0, 2)).map(({ n, ...x }) => x);
      }
      // The records do not hold what was asked: say what they do hold and offer to ask the right person.
      if (!w.answered) {
        const offer = await handoffOffer(ctx, { text: r.question, domain: r.domain, subject: r.subject, person: r.person, child: r.child });
        r.action = 'no_data';
        r.options = [offer.option];
        ctx.setPending({ text: r.question, kind: 'handoff', domain: r.domain, subject: r.subject, person: r.person, child: r.child, summary: r.summary, options: [offer.option] });
      }
    }
  }
  if (worded) {
    if (worded.ai) ctx.noteAi(worded.ai);
    for (const { id, r } of wordable) {
      const w = worded.result.get(id);
      if (w && !w.rejected && w.text !== r.text) { r.text = w.text; aiInfo.rewritten = true; }
      if (w?.rejected) r.groundedCheck = 'kept_original';
    }
  }

  ctx.trace.step('respond', { replies: replies.length, actions: ctx.actionLog.map((a) => a.name) });

  // Conversation memory.
  conversation.remember(conv, { userText: shown, replies });
  conv.state.pending = ctx.newPending || emptyPending();
  conv.turns += 1;
  conv.lastActiveAt = new Date();
  conv.markModified('state');
  await conv.save();

  if (aiInfo.used) await recordUsage(schoolId, AI_METRIC);

  const ACTION_RANK = ['handoff', 'clarify', 'blocked', 'no_data', 'answer'];
  const overall = ACTION_RANK.find((a) => replies.some((r) => r.action === a)) || 'answer';
  const log = await AssistantQuery.create({
    school: schoolId, user: user._id, role: user.role, conversation: conv._id,
    text: redact(shown).slice(0, 1000), language,
    parts: replies.map((r, i) => ({
      text: redact(r.question || shown).slice(0, 600),
      domain: r.domain, confidence: r.confidence, runnerUp: r.runnerUp || null, method: r.method, action: r.action,
      sources: r.sources.length, grounded: r.action !== 'answer' || r.sources.length > 0, composition: r.composition || 'standard', ticket: r.ticket?.id || null,
    })),
    action: overall, latencyMs: Date.now() - started, ai: aiInfo,
    requestId: trace.requestId, trace: trace.steps.slice(0, 24), actions: ctx.actionLog,
  });
  trace.finish({ conversationId: String(conv._id), action: overall, provider: aiInfo.provider, language });

  return {
    conversationId: String(conv._id),
    queryId: String(log._id),
    requestId: trace.requestId,
    language,
    replies: replies.map(({ generated, groundedCheck, composition, runnerUp, question, facts, subject, person, child, summary, ...r }) => r),
    ai: { used: aiInfo.used, provider: aiInfo.provider },
  };
}

module.exports = { ask, answerQuestion, matchOption, AI_METRIC, suggestionsFor };
