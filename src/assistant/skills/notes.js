// Homework & notes skill: study material and assignments from Note (uploaded by teachers per class).
//   students and parents: their class's latest material, assignments with upcoming due dates first
//   teachers: what they uploaded recently;  admins: uploads across the school this week

const Note = require('../../models/Note');
const { hasPhrase, tokenize } = require('../text');
const { day, today, addDays, plural, studentLabel, link, source, escapeRegex } = require('./util');

const HOMEWORK_WORDS = ['homework', 'home work', 'hw', 'assignment', 'assignments', 'grihkarya', 'submit', 'submission', 'worksheet'];

async function subjectIn(ctx, filter) {
  const subjects = await Note.distinct('subject', { school: ctx.schoolId, ...filter });
  const tokens = tokenize(ctx.text);
  return subjects.find((s) => tokenize(s).some((w) => w.length >= 4 && tokens.includes(w))) || null;
}

async function forClass(ctx, student) {
  const filter = { class: { $regex: `^${escapeRegex(student.class)}$`, $options: 'i' }, section: { $in: [student.section, ''] } };
  const subject = await subjectIn(ctx, filter);
  if (subject) filter.subject = subject;
  const who = ctx.role === 'student' ? 'your class' : studentLabel(student);
  const what = subject ? `${subject} ` : '';

  if (hasPhrase(ctx.text, HOMEWORK_WORDS)) {
    const due = await Note.find({ school: ctx.schoolId, ...filter, type: 'Assignment', dueDate: { $gte: today(ctx.now) } }).sort({ dueDate: 1 }).limit(6).lean();
    const recent = due.length ? due : await Note.find({ school: ctx.schoolId, ...filter, type: 'Assignment' }).sort({ createdAt: -1 }).limit(3).lean();
    if (!recent.length) return { text: `No ${what}homework or assignments have been posted for ${who}.`, facts: { for: who, assignments: 0 }, sources: [] };
    return {
      text: `${due.length ? `${what}Homework due for ${who}` : `No pending ${what}homework for ${who}. Latest assignments`}:\n${recent.map((n) => `- ${n.subject}: ${n.title}${n.dueDate ? `, due ${day(n.dueDate, { weekday: true })}` : ''}${n.teacherName ? ` (${n.teacherName})` : ''}`).join('\n')}`,
      facts: { for: who, pending: due.length, items: recent.map((n) => ({ subject: n.subject, title: n.title, due: n.dueDate ? day(n.dueDate) : null })) },
      sources: recent.slice(0, 3).map((n) => source('note', `Assignment · ${n.title}`, n._id)),
    };
  }
  const notes = await Note.find({ school: ctx.schoolId, ...filter }).sort({ createdAt: -1 }).limit(5).lean();
  if (!notes.length) return { text: `No ${what}study material has been uploaded for ${who} yet.`, facts: { for: who, notes: 0 }, sources: [] };
  return {
    text: `Latest ${what}study material for ${who}:\n${notes.map((n) => `- ${n.subject}: ${n.title} (${n.type}, ${day(n.createdAt, { short: true })})`).join('\n')}`,
    facts: { for: who, items: notes.map((n) => ({ subject: n.subject, title: n.title, type: n.type, uploaded: day(n.createdAt) })) },
    sources: notes.slice(0, 3).map((n) => source('note', `${n.type} · ${n.title}`, n._id)),
  };
}

async function run(ctx) {
  let out;
  if (ctx.students?.length) {
    const parts = [];
    for (const s of ctx.students) parts.push(await forClass(ctx, s));
    out = { text: parts.map((p) => p.text).join('\n\n'), facts: { items: parts.map((p) => p.facts) }, sources: parts.flatMap((p) => p.sources) };
  } else if (ctx.role === 'teacher') {
    const mine = await Note.find({ school: ctx.schoolId, uploadedBy: ctx.user._id }).sort({ createdAt: -1 }).limit(5).lean();
    out = mine.length
      ? { text: `Your latest uploads:\n${mine.map((n) => `- ${n.subject}, ${n.class}${n.section ? `-${n.section}` : ''}: ${n.title} (${day(n.createdAt, { short: true })})`).join('\n')}`, facts: { items: mine.map((n) => ({ subject: n.subject, title: n.title, class: n.class })) }, sources: mine.slice(0, 3).map((n) => source('note', n.title, n._id)) }
      : { text: 'You have not uploaded any study material yet.', facts: { uploads: 0 }, sources: [] };
  } else if (ctx.role === 'admin') {
    const since = addDays(ctx.now, -6);
    const count = await Note.countDocuments({ school: ctx.schoolId, createdAt: { $gte: since } });
    const pending = await Note.countDocuments({ school: ctx.schoolId, type: 'Assignment', dueDate: { $gte: today(ctx.now) } });
    out = { text: `In the last 7 days teachers uploaded ${plural(count, 'item')} of study material. ${plural(pending, 'assignment')} ${pending === 1 ? 'is' : 'are'} open with a future due date.`, facts: { uploadsLast7Days: count, openAssignments: pending }, sources: [source('report', 'Study material · last 7 days')] };
  } else {
    return { noData: true, text: 'I could not find a student record linked to your account. Please ask the school office to link it.' };
  }
  return { ...out, link: link('notes', ctx.role) };
}

module.exports = { run, needsStudent: true };
