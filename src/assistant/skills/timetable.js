// Timetable skill: periods for a day from Timetable (one document per class-section per weekday).
//   students and parents: their class (default today; Sunday moves to Monday)
//   teachers: their own periods across classes
//   admins: a named class (asks which class when none is given)

const Timetable = require('../../models/Timetable');
const Teacher = require('../../models/Teacher');
const { parseWhen, WEEKDAYS } = require('../entities');
const { hasPhrase } = require('../text');
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

async function forTeacher(ctx) {
  const t = targetDay(ctx);
  if (!ctx.teacher) return { noData: true, text: 'I could not find your teacher record. Please ask the school office.' };
  const tts = await Timetable.find({ school: ctx.schoolId, day: t.weekday, 'periods.teacher': ctx.teacher._id }).lean();
  const mine = tts.flatMap((tt) => tt.periods.filter((p) => String(p.teacher) === String(ctx.teacher._id))
    .map((p, i) => ({ no: periodNo(p, i), subject: p.subject, time: periodTime(p), cls: `${tt.class}-${tt.section}`, start: toMinutes(p.startTime || p.time) })))
    .sort((a, b) => (a.start ?? a.no * 100) - (b.start ?? b.no * 100) || a.no - b.no);
  if (!mine.length) return { text: `${t.note}You have no periods on ${t.weekday} (${day(t.d, { short: true })}).`, facts: { day: t.weekday, periods: 0 }, sources: [] };
  if (t.isToday && hasPhrase(ctx.text, NEXT_WORDS)) {
    const nowMin = minutesNow(ctx.now);
    const next = mine.find((p) => (p.start ?? -1) > nowMin);
    return next
      ? { text: `Your next period today: ${next.subject} in ${next.cls}${next.time ? ` (${next.time})` : ''}.`, facts: { next }, sources: [source('timetable', `Timetable · ${t.weekday}`)] }
      : { text: 'You have no more periods today.', facts: { day: t.weekday }, sources: [source('timetable', `Timetable · ${t.weekday}`)] };
  }
  return {
    text: `${t.note}Your periods on ${t.weekday} (${day(t.d, { short: true })}):\n${mine.map((p) => `- Period ${p.no}: ${p.subject} in ${p.cls}${p.time ? ` (${p.time})` : ''}`).join('\n')}`,
    facts: { day: t.weekday, periods: mine.map(({ start, ...p }) => p) },
    sources: [source('timetable', `Timetable · ${t.weekday}`)],
  };
}

async function run(ctx) {
  let out;
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

module.exports = { run, needsStudent: true };
