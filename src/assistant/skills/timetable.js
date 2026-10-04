// Timetable skill: periods for a day from Timetable (one document per class-section per weekday).
//   students and parents: their class (default today; Sunday moves to Monday)
//   teachers: their own periods across classes
//   admins: a named class (asks which class when none is given)

const Timetable = require('../../models/Timetable');
const Teacher = require('../../models/Teacher');
const { parseWhen, WEEKDAYS } = require('../entities');
const { hasPhrase, tokenize, closeEnough } = require('../text');
const { day, today, addDays, studentLabel, link, source, escapeRegex } = require('./util');
const { SCHOOL_TZ } = require('../../utils/dates');

const NEXT_WORDS = ['next', 'agla', 'agli', 'abhi', 'now', 'current', 'ab kaunsa', 'ab kaunsi'];
const FIRST_WORDS = ['first period', 'pehla period', 'pehli class', 'first class'];

function targetDay(ctx) {
  const when = parseWhen(ctx.text, { direction: 'future', now: ctx.now });
  let d = when?.day || today(ctx.now);
  let note = '';
  if (d.getUTCDay() === 0) { d = addDays(d, 1); note = 'Sunday is a holiday, so here is Monday. '; }
  return { d, weekday: WEEKDAYS[d.getUTCDay()], note, isToday: d.getTime() === today(ctx.now).getTime() };
}

const periodNo = (p, i) => p.periodNo || p.no || i + 1;
const periodTime = (p) => p.time || (p.startTime && p.endTime ? `${p.startTime}-${p.endTime}` : '');

function minutesNow(now) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: SCHOOL_TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(now).split(':');
  return Number(parts[0]) * 60 + Number(parts[1]);
}
const toMinutes = (hhmm) => {
  const m = String(hhmm || '').match(/(\d{1,2}):(\d{2})/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

async function teacherNames(ctx, periods) {
  const ids = [...new Set(periods.map((p) => p.teacher).filter(Boolean).map(String))];
  if (!ids.length) return new Map();
  const ts = await Teacher.find({ _id: { $in: ids }, school: ctx.schoolId }).select('name').lean();
  return new Map(ts.map((t) => [String(t._id), t.name]));
}

// `who` = { title: 'your class' | 'Aditya (7-A)' | 'Class 8-B', owner: "Your" | "Aditya's" | "Class 8-B's" }
async function forClass(ctx, cls, section, who) {
  const t = targetDay(ctx);
  const q = { school: ctx.schoolId, class: { $regex: `^${escapeRegex(cls)}$`, $options: 'i' }, day: t.weekday };
  if (section) q.section = section;
  const tt = await Timetable.findOne(q).lean();
  const name = `${cls}${section ? `-${section}` : ''}`;
  if (!tt || !tt.periods?.length) {
    return { text: `${t.note}No timetable has been set for Class ${name} on ${t.weekday}.`, facts: { class: name, day: t.weekday, periods: 0 }, sources: [] };
  }
  const periods = [...tt.periods].sort((a, b) => periodNo(a, 0) - periodNo(b, 0));
  const names = await teacherNames(ctx, periods);
  const line = (p, i) => `${periodNo(p, i)}. ${p.subject || 'Free'}${periodTime(p) ? ` (${periodTime(p)})` : ''}${p.teacher && names.get(String(p.teacher)) ? ` - ${names.get(String(p.teacher))}` : ''}`;

  // "Next period" today: the first period that has not started yet.
  if (t.isToday && hasPhrase(ctx.text, NEXT_WORDS)) {
    const nowMin = minutesNow(ctx.now);
    const next = periods.find((p) => (toMinutes(p.startTime || periodTime(p)) ?? -1) > nowMin);
    if (next) {
      return {
        text: `${who.owner} next period today is ${line(next, periods.indexOf(next))}.`,
        facts: { class: name, day: t.weekday, next: { no: periodNo(next, 0), subject: next.subject, time: periodTime(next) } },
        sources: [source('timetable', `Timetable · ${name} · ${t.weekday}`, tt._id)],
      };
    }
    return { text: `There are no more periods today for ${who.title}.`, facts: { class: name, day: t.weekday }, sources: [source('timetable', `Timetable · ${name} · ${t.weekday}`, tt._id)] };
  }
  if (hasPhrase(ctx.text, FIRST_WORDS)) {
    return {
      text: `${t.note}${who.owner} first period on ${t.weekday} (${day(t.d, { short: true })}) is ${line(periods[0], 0)}.`,
      facts: { class: name, day: t.weekday, first: { subject: periods[0].subject, time: periodTime(periods[0]) } },
      sources: [source('timetable', `Timetable · ${name} · ${t.weekday}`, tt._id)],
    };
  }
  return {
    text: `${t.note}Timetable for ${who.title} on ${t.weekday} (${day(t.d, { short: true })}):\n${periods.map((p, i) => `- ${line(p, i)}`).join('\n')}`,
    facts: { class: name, day: t.weekday, periods: periods.map((p, i) => ({ no: periodNo(p, i), subject: p.subject, time: periodTime(p) })) },
    sources: [source('timetable', `Timetable · ${name} · ${t.weekday}`, tt._id)],
  };
}

// A teacher's own periods for a day across classes; staff can ask about a named teacher (self = false).
async function forTeacher(ctx, teacher = ctx.teacher, self = true) {
  const t = targetDay(ctx);
  if (!teacher) return { noData: true, text: 'I could not find your teacher record. Please ask the school office.' };
  const who = self ? 'You have' : `${teacher.name} has`;
  const whose = self ? 'Your' : `${teacher.name}'s`;
  const tts = await Timetable.find({ school: ctx.schoolId, day: t.weekday, 'periods.teacher': teacher._id }).lean();
  const mine = tts.flatMap((tt) => tt.periods.filter((p) => String(p.teacher) === String(teacher._id))
    .map((p, i) => ({ no: periodNo(p, i), subject: p.subject, time: periodTime(p), cls: `${tt.class}-${tt.section}`, start: toMinutes(p.startTime || p.time) })))
    .sort((a, b) => (a.start ?? a.no * 100) - (b.start ?? b.no * 100) || a.no - b.no);
  if (!mine.length) return { text: `${t.note}${who} no periods on ${t.weekday} (${day(t.d, { short: true })}).`, facts: { teacher: teacher.name, day: t.weekday, periods: 0 }, sources: [] };
  if (t.isToday && hasPhrase(ctx.text, NEXT_WORDS)) {
    const nowMin = minutesNow(ctx.now);
    const next = mine.find((p) => (p.start ?? -1) > nowMin);
    return next
      ? { text: `${whose} next period today: ${next.subject} in ${next.cls}${next.time ? ` (${next.time})` : ''}.`, facts: { teacher: teacher.name, next }, sources: [source('timetable', `Timetable · ${t.weekday}`)] }
      : { text: `${who} no more periods today.`, facts: { teacher: teacher.name, day: t.weekday }, sources: [source('timetable', `Timetable · ${t.weekday}`)] };
  }
  return {
    text: `${t.note}${whose} periods on ${t.weekday} (${day(t.d, { short: true })}):\n${mine.map((p) => `- Period ${p.no}: ${p.subject} in ${p.cls}${p.time ? ` (${p.time})` : ''}`).join('\n')}`,
    facts: { teacher: teacher.name, day: t.weekday, periods: mine.map(({ start, ...p }) => p) },
    sources: [source('timetable', `Timetable · ${t.weekday}`)],
  };
}

// "Simarpreet sir ki class kab hai?": the periods a named teacher takes in the child's (or asked-for) class.
const TEACHER_WORDS = ['sir', 'madam', 'maam', 'mam', 'miss', 'teacher', 'ji', 'sirs'];
const NAME_STOP = new Set(['class', 'periods', 'period', 'timetable', 'kab', 'kaun', 'kaunsi', 'kaunsa', 'hai', 'hain', 'ki', 'ka', 'ke', 'aaj', 'kal', 'next', 'when', 'what', 'which', 'teacher', 'sir', 'madam', 'maam', 'mam', 'miss', 'wale', 'wali']);

async function findNamedTeachers(ctx) {
  // The model names the person; without it a name only counts when written with Sir, Madam, Miss and so on.
  const fromModel = ctx.personName ? tokenize(ctx.personName) : null;
  const tokens = (fromModel || tokenize(ctx.text)).filter((t) => t.length >= 4 && !NAME_STOP.has(t) && /^[a-z]+$/.test(t));
  if (!tokens.length || (!fromModel && !tokenize(ctx.text).some((t) => TEACHER_WORDS.includes(t)))) return [];
  const teachers = await Teacher.find({ school: ctx.schoolId, isActive: true }).select('name subjects').lean();
  return teachers.filter((t) => tokenize(t.name).some((w) => w.length >= 4 && tokens.some((tok) => closeEnough(tok, w))));
}

async function forNamedTeacher(ctx, teachers, cls, section, who) {
  const ids = new Set(teachers.map((t) => String(t._id)));
  const rows = await Timetable.find({ school: ctx.schoolId, class: { $regex: `^${escapeRegex(cls)}$`, $options: 'i' }, ...(section ? { section } : {}) }).lean();
  const byDay = new Map();
  for (const tt of rows) {
    for (const p of tt.periods || []) {
      if (!p.teacher || !ids.has(String(p.teacher))) continue;
      const list = byDay.get(tt.day) || [];
      list.push({ no: periodNo(p, list.length), subject: p.subject, time: periodTime(p) });
      byDay.set(tt.day, list);
    }
  }
  const name = teachers.map((t) => t.name).join(' / ');
  if (!byDay.size) {
    return { text: `${name} has no period in ${who.title}'s timetable.`, facts: { teacher: name, periods: 0 }, sources: [source('timetable', `Timetable · ${cls}${section ? `-${section}` : ''}`)] };
  }
  const days = WEEKDAYS.filter((d) => byDay.has(d));
  const subjects = [...new Set(days.flatMap((d) => byDay.get(d).map((p) => p.subject)))].filter(Boolean);
  // Days with the same periods are listed together ("Monday to Saturday").
  const groups = [];
  for (const d of days) {
    const text = byDay.get(d).sort((x, y) => x.no - y.no).map((p) => `period ${p.no}${p.time ? ` (${p.time})` : ''}`).join(', ');
    const last = groups[groups.length - 1];
    if (last && last.text === text && WEEKDAYS.indexOf(last.to) === WEEKDAYS.indexOf(d) - 1) last.to = d;
    else groups.push({ from: d, to: d, text });
  }
  const lines = groups.map((g) => `- ${g.from === g.to ? g.from : g.to === WEEKDAYS[WEEKDAYS.indexOf(g.from) + 1] ? `${g.from} and ${g.to}` : `${g.from} to ${g.to}`}: ${g.text}`);
  return {
    text: `${name} takes ${subjects.join(' and ') || 'classes'} for ${who.title}:\n${lines.join('\n')}`,
    facts: { teacher: name, subjects, days: days.map((d) => ({ day: d, periods: byDay.get(d) })) },
    sources: [source('timetable', `Timetable · ${cls}${section ? `-${section}` : ''}`)],
  };
}

async function run(ctx) {
  let out;
  const named = await findNamedTeachers(ctx);
  if (named.length && ctx.students?.length) {
    const parts = [];
    for (const s of ctx.students) parts.push(await forNamedTeacher(ctx, named, s.class, s.section, { title: ctx.role === 'student' ? 'your class' : studentLabel(s) }));
    return { text: parts.map((p) => p.text).join('\n\n'), facts: { teachers: parts.map((p) => p.facts) }, sources: parts.flatMap((p) => p.sources), link: link('timetable', ctx.role) };
  }
  if (named.length && ctx.cls) {
    const label = `Class ${ctx.cls.class}${ctx.cls.section ? `-${ctx.cls.section}` : ''}`;
    const r = await forNamedTeacher(ctx, named, ctx.cls.class, ctx.cls.section, { title: label });
    return { ...r, link: link('timetable', ctx.role) };
  }
  if (named.length === 1 && !ctx.students?.length && !ctx.cls) {
    const t = await forTeacher(ctx, named[0], String(named[0]._id) === String(ctx.teacher?._id));
    return { ...t, link: link('timetable', ctx.role) };
  }
  if (ctx.students?.length) {
    const parts = [];
    for (const s of ctx.students) {
      const who = ctx.role === 'student' ? { title: 'your class', owner: 'Your' } : { title: studentLabel(s), owner: `${s.name}'s` };
      parts.push(await forClass(ctx, s.class, s.section, who));
    }
    out = { text: parts.map((p) => p.text).join('\n\n'), facts: { classes: parts.map((p) => p.facts) }, sources: parts.flatMap((p) => p.sources) };
  } else if (ctx.role === 'teacher' && !ctx.cls) out = await forTeacher(ctx);
  else if (ctx.cls) {
    const name = `Class ${ctx.cls.class}${ctx.cls.section ? `-${ctx.cls.section}` : ''}`;
    out = await forClass(ctx, ctx.cls.class, ctx.cls.section, { title: name, owner: `${name}'s` });
  }
  else return { need: { kind: 'class', question: 'Which class would you like the timetable for?' } };
  return { ...out, link: link('timetable', ctx.role) };
}

module.exports = { run, needsStudent: true, staffCanName: true, classLevel: () => true };
