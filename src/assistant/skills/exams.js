// Exams skill: the exam schedule (ExamSchedule) and published results (ExamResult, written only when
// marks are published, so draft marks are never shown).
//   students and parents: their class's upcoming exams, their own latest results
//   teachers: upcoming exams of their classes
//   admins: upcoming exams for the school or a class

const ExamSchedule = require('../../models/ExamSchedule');
const ExamResult = require('../../models/ExamResult');
const { parseWhen } = require('../entities');
const { hasPhrase, tokenize } = require('../text');
const { teacherCoversClass, parseClassKey } = require('../../utils/classes');
const { day, today, addDays, plural, studentLabel, link, source, escapeRegex } = require('./util');

const RESULT_WORDS = ['result', 'results', 'marks', 'mark', 'number', 'numbers', 'score', 'grade', 'grades', 'percentage', 'report card', 'rank', 'kitne aaye', 'pass', 'fail'];

const examLine = (e) => `${day(e.date, { weekday: true })}: ${e.subject} (${e.title}${e.startTime ? `, ${e.startTime}${e.endTime ? `-${e.endTime}` : ''}` : ''})${e.class && e._showClass ? ` for ${e.class}${e.section ? `-${e.section}` : ''}` : ''}`;

function window(ctx) {
  const when = parseWhen(ctx.text, { direction: 'future', now: ctx.now });
  if (when?.day) return { from: when.day, to: when.day, label: when.label === 'today' || when.label === 'tomorrow' ? when.label : `on ${day(when.day, { weekday: true })}` };
  if (when?.from) return { from: when.from < today(ctx.now) ? today(ctx.now) : when.from, to: when.to, label: when.label };
  return { from: today(ctx.now), to: addDays(ctx.now, 60), label: 'coming up' };
}

// Optional subject filter: a word of the question that matches a subject name.
function subjectFilter(text, subjects) {
  const tokens = tokenize(text);
  return subjects.find((s) => tokenize(s).some((w) => w.length >= 4 && tokens.includes(w))) || null;
}

async function schedule(ctx, filter, title) {
  const w = window(ctx);
  const exams = await ExamSchedule.find({ school: ctx.schoolId, ...filter, date: { $gte: w.from, $lte: w.to } }).sort({ date: 1, startTime: 1 }).limit(12).lean();
  if (!exams.length) {
    return { text: `No exams are scheduled ${w.label === 'coming up' ? 'in the next 60 days' : w.label} for ${title}.`, facts: { for: title, exams: 0 }, sources: [] };
  }
  const showClass = !filter.class;
  return {
    text: `Exams ${w.label} for ${title}:\n${exams.slice(0, 8).map((e) => `- ${examLine({ ...e, _showClass: showClass })}`).join('\n')}${exams.length > 8 ? `\n- and ${plural(exams.length - 8, 'more exam')}` : ''}`,
    facts: { for: title, exams: exams.slice(0, 8).map((e) => ({ date: day(e.date), subject: e.subject, title: e.title, start: e.startTime || null, class: `${e.class}${e.section ? `-${e.section}` : ''}` })) },
    sources: exams.slice(0, 3).map((e) => source('exam', `Exam schedule · ${e.subject} · ${day(e.date, { short: true })}`, e._id)),
    screen: 'exams',
  };
}

const classFilter = (cls, section) => ({
  class: { $regex: `^${escapeRegex(cls)}$`, $options: 'i' },
  ...(section ? { section: { $in: [section, ''] } } : {}),
});

async function results(ctx, student) {
  const label = studentLabel(student);
  const all = await ExamResult.find({ school: ctx.schoolId, student: student._id }).sort({ examDate: -1, createdAt: -1 }).lean();
  if (!all.length) return { text: `No results have been published for ${label} yet.`, facts: { student: label, results: 0 }, sources: [], screen: 'results' };

  const subject = subjectFilter(ctx.text, [...new Set(all.map((r) => r.subject))]);
  if (subject) {
    const rows = all.filter((r) => r.subject === subject).slice(0, 3);
    return {
      text: `${label}, ${subject}:\n${rows.map((r) => `- ${r.examName}: ${r.absent ? 'absent' : `${r.marksObtained}/${r.totalMarks}${r.grade ? `, grade ${r.grade}` : ''}`}`).join('\n')}`,
      facts: { student: label, subject, results: rows.map((r) => ({ exam: r.examName, marks: r.marksObtained, total: r.totalMarks, grade: r.grade || null, absent: !!r.absent })) },
      sources: rows.map((r) => source('result', `Result · ${r.examName} · ${r.subject}`, r._id)),
      screen: 'results',
    };
  }
  const latestExam = all[0].examName;
  const examTitle = String(latestExam).replace(/[.\s]+$/, '');
  const rows = all.filter((r) => r.examName === latestExam);
  const got = rows.filter((r) => !r.absent).reduce((s, r) => s + r.marksObtained, 0);
  const max = rows.filter((r) => !r.absent).reduce((s, r) => s + r.totalMarks, 0);
  const percentage = max ? Math.round((got / max) * 1000) / 10 : 0;
  return {
    text: `${label}, ${examTitle}: ${got}/${max} (${percentage}%).\n${rows.map((r) => `- ${r.subject}: ${r.absent ? 'absent' : `${r.marksObtained}/${r.totalMarks}${r.grade ? ` (${r.grade})` : ''}`}`).join('\n')}`,
    facts: { student: label, exam: latestExam, obtained: got, total: max, percentage, subjects: rows.map((r) => ({ subject: r.subject, marks: r.marksObtained, total: r.totalMarks, grade: r.grade || null, absent: !!r.absent })) },
    sources: [source('result', `Published result · ${examTitle}`)],
    screen: 'results',
  };
}

async function run(ctx) {
  const wantsResults = hasPhrase(ctx.text, RESULT_WORDS);
  let out;
  if (ctx.students?.length) {
    const parts = [];
    for (const s of ctx.students) {
      if (wantsResults) parts.push(await results(ctx, s));
      else parts.push(await schedule(ctx, classFilter(s.class, s.section), ctx.role === 'student' ? 'your class' : studentLabel(s)));
    }
    out = { text: parts.map((p) => p.text).join('\n\n'), facts: { items: parts.map((p) => p.facts) }, sources: parts.flatMap((p) => p.sources), screen: parts[0].screen };
  } else if (ctx.role === 'teacher') {
    if (wantsResults) return { noData: true, text: 'Marks for your classes are on the Marks screen.', link: link('results', 'teacher') };
    const classes = (ctx.teacher?.assignedClasses || []).map((c) => parseClassKey(c));
    if (ctx.cls && !teacherCoversClass(ctx.teacher, ctx.cls.class, ctx.cls.section)) {
      return { blocked: true, text: `Class ${ctx.cls.class}${ctx.cls.section ? `-${ctx.cls.section}` : ''} is not one of your assigned classes.` };
    }
    const wanted = ctx.cls ? [ctx.cls] : classes;
    if (!wanted.length) return { noData: true, text: 'No classes are assigned to you yet.' };
    out = await schedule(ctx, { $or: wanted.map((c) => classFilter(c.class, c.section)) }, ctx.cls ? `Class ${ctx.cls.class}${ctx.cls.section ? `-${ctx.cls.section}` : ''}` : 'your classes');
  } else if (ctx.role === 'admin') {
    if (wantsResults && !ctx.cls) return { noData: true, text: 'Results by class and exam are on the Results screen. Ask about one student by name to see their marks.', link: link('results', 'admin') };
    out = await schedule(ctx, ctx.cls ? classFilter(ctx.cls.class, ctx.cls.section) : {}, ctx.cls ? `Class ${ctx.cls.class}${ctx.cls.section ? `-${ctx.cls.section}` : ''}` : 'the school');
  } else {
    return { noData: true, text: 'I could not find a student record linked to your account. Please ask the school office to link it.' };
  }
  return { ...out, link: link(out.screen || 'exams', ctx.role) };
}

module.exports = { run, needsStudent: true, staffCanName: true };
