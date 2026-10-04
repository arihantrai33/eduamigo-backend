// Attendance skill: from Attendance records (one per student per school day).
//   students and parents: a day's status, or counts and percentage for a period (default: this month)
//   teachers: their own classes for a day (default today), with absentees
//   admins: the whole school or one class for a day, including classes not marked yet

const Attendance = require('../../models/Attendance');
const Student = require('../../models/Student');
const { parseWhen } = require('../entities');
const { teacherCoversClass, parseClassKey } = require('../../utils/classes');
const { day, today, plural, studentLabel, link, source, sessionStart, escapeRegex } = require('./util');

const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : 0);

function summarize(records) {
  const c = { Present: 0, Absent: 0, Late: 0, Leave: 0, Holiday: 0 };
  records.forEach((r) => { c[r.status] = (c[r.status] || 0) + 1; });
  const schoolDays = c.Present + c.Absent + c.Late + c.Leave;
  return { ...c, schoolDays, percentage: pct(c.Present + c.Late, schoolDays) };
}

async function forStudent(ctx, student) {
  const label = studentLabel(student);
  const when = parseWhen(ctx.text, { direction: 'past', now: ctx.now });

  if (when?.day) {
    const rec = await Attendance.findOne({ school: ctx.schoolId, studentId: student._id, date: when.day }).lean();
    if (!rec) {
      return { text: `Attendance for ${label} on ${day(when.day, { weekday: true })} has not been marked.`, facts: { student: label, date: day(when.day), marked: false }, sources: [] };
    }
    return {
      text: `${label} was ${rec.status.toLowerCase()} on ${day(when.day, { weekday: true })}${rec.remarks ? ` (${rec.remarks})` : ''}.`,
      facts: { student: label, date: day(when.day), status: rec.status },
      sources: [source('attendance', `Attendance · ${day(when.day)}`, rec._id)],
    };
  }

  const range = when?.from ? when : { from: new Date(Date.UTC(today(ctx.now).getUTCFullYear(), today(ctx.now).getUTCMonth(), 1)), to: today(ctx.now), label: 'this month' };
  const from = when?.session ? sessionStart(ctx.now) : range.from;
  const to = when?.session ? today(ctx.now) : range.to;
  let periodLabel = when?.session ? 'this session' : range.label;
  let noneThisMonth = false;
  let records = await Attendance.find({ school: ctx.schoolId, studentId: student._id, date: { $gte: from, $lte: to } }).sort({ date: 1 }).lean();
  // Nothing marked this month yet (start of a month, or a new school): show the session so far instead.
  if (!records.length && !when) {
    records = await Attendance.find({ school: ctx.schoolId, studentId: student._id, date: { $gte: sessionStart(ctx.now), $lte: today(ctx.now) } }).sort({ date: 1 }).lean();
    if (records.length) { periodLabel = 'this session'; noneThisMonth = true; }
  }
  const s = summarize(records);
  if (!s.schoolDays) {
    return { text: `No attendance has been marked for ${label} ${periodLabel}.`, facts: { student: label, period: periodLabel, schoolDays: 0 }, sources: [] };
  }
  const absentDays = records.filter((r) => r.status === 'Absent').map((r) => day(r.date, { short: true }));
  const lines = [
    `${label}, ${periodLabel}: present ${s.Present + s.Late} of ${plural(s.schoolDays, 'day')} (${s.percentage}%), absent ${plural(s.Absent, 'day')}${s.Late ? `, late ${s.Late}` : ''}${s.Leave ? `, on leave ${s.Leave}` : ''}.`,
    ...(noneThisMonth ? ['No attendance has been marked this month yet.'] : []),
  ];
  if (absentDays.length) lines.push(`Absent on: ${absentDays.slice(-6).join(', ')}${absentDays.length > 6 ? ' and earlier' : ''}.`);
  return {
    text: lines.join('\n'),
    facts: { student: label, period: periodLabel, present: s.Present + s.Late, schoolDays: s.schoolDays, percentage: s.percentage, absent: s.Absent, late: s.Late, leave: s.Leave, absentDays: absentDays.slice(-6) },
    sources: [source('attendance', `Attendance · ${periodLabel}`)],
  };
}

// One class on one day: counts and absentees. `cls` = { class, section }.
async function classDay(ctx, cls, dayKey) {
  const q = { school: ctx.schoolId, class: { $regex: `^${escapeRegex(cls.class)}$`, $options: 'i' }, date: dayKey };
  if (cls.section) q.section = cls.section;
  const records = await Attendance.find(q).populate('studentId', 'name').lean();
  const s = summarize(records);
  const absentees = records.filter((r) => r.status === 'Absent').map((r) => r.studentId?.name).filter(Boolean);
  return { s, absentees, marked: records.length > 0 };
}

async function forTeacher(ctx) {
  const when = parseWhen(ctx.text, { direction: 'past', now: ctx.now });
  const dayKey = when?.day || today(ctx.now);
  const classes = (ctx.teacher?.assignedClasses || []).map((c) => parseClassKey(c));
  let wanted = classes;
  if (ctx.cls) {
    if (!teacherCoversClass(ctx.teacher, ctx.cls.class, ctx.cls.section)) {
      return { blocked: true, text: `Class ${ctx.cls.class}${ctx.cls.section ? `-${ctx.cls.section}` : ''} is not one of your assigned classes.` };
    }
    wanted = [ctx.cls];
  }
  if (!wanted.length) return { noData: true, text: 'No classes are assigned to you yet. Please ask the school office.' };

  const lines = [`Attendance on ${day(dayKey, { weekday: true })}:`];
  const facts = [];
  for (const c of wanted) {
    const r = await classDay(ctx, c, dayKey);
    const name = `${c.class}${c.section ? `-${c.section}` : ''}`;
    if (!r.marked) { lines.push(`- ${name}: not marked yet`); facts.push({ class: name, marked: false }); continue; }
    lines.push(`- ${name}: ${r.s.Present + r.s.Late} present, ${r.s.Absent} absent${r.absentees.length ? ` (${r.absentees.slice(0, 8).join(', ')}${r.absentees.length > 8 ? '...' : ''})` : ''}`);
    facts.push({ class: name, present: r.s.Present + r.s.Late, absent: r.s.Absent, absentees: r.absentees.slice(0, 8) });
  }
  return { text: lines.join('\n'), facts: { date: day(dayKey), classes: facts }, sources: [source('attendance', `Attendance · ${day(dayKey)}`)] };
}

async function forAdmin(ctx) {
  const when = parseWhen(ctx.text, { direction: 'past', now: ctx.now });
  const dayKey = when?.day || today(ctx.now);
  if (ctx.cls) {
    const r = await classDay(ctx, ctx.cls, dayKey);
    const name = `${ctx.cls.class}${ctx.cls.section ? `-${ctx.cls.section}` : ''}`;
    if (!r.marked) return { text: `Attendance for Class ${name} on ${day(dayKey, { weekday: true })} has not been marked yet.`, facts: { class: name, marked: false }, sources: [] };
    return {
      text: `Class ${name} on ${day(dayKey, { weekday: true })}: ${r.s.Present + r.s.Late} present, ${r.s.Absent} absent (${r.s.percentage}%).${r.absentees.length ? `\nAbsent: ${r.absentees.slice(0, 15).join(', ')}${r.absentees.length > 15 ? '...' : ''}` : ''}`,
      facts: { class: name, date: day(dayKey), present: r.s.Present + r.s.Late, absent: r.s.Absent, percentage: r.s.percentage, absentees: r.absentees.slice(0, 15) },
      sources: [source('attendance', `Attendance · ${name} · ${day(dayKey)}`)],
    };
  }
  const records = await Attendance.find({ school: ctx.schoolId, date: dayKey }).select('status class section').lean();
  const s = summarize(records);
  const sections = await Student.aggregate([
    { $match: { school: ctx.schoolId, isActive: true } },
    { $group: { _id: { class: '$class', section: '$section' } } },
  ]);
  const markedKeys = new Set(records.map((r) => `${r.class}-${r.section}`));
  const notMarked = sections.map((g) => `${g._id.class}-${g._id.section}`).filter((k) => !markedKeys.has(k)).sort();
  if (!records.length) {
    return { text: `No attendance has been marked on ${day(dayKey, { weekday: true })} yet (${plural(sections.length, 'class section')} to mark).`, facts: { date: day(dayKey), marked: 0, sections: sections.length }, sources: [] };
  }
  return {
    text: `School attendance on ${day(dayKey, { weekday: true })}: ${s.Present + s.Late} present, ${s.Absent} absent out of ${s.schoolDays} marked (${s.percentage}%).${notMarked.length ? `\nNot marked yet: ${notMarked.slice(0, 12).join(', ')}${notMarked.length > 12 ? '...' : ''}` : '\nEvery class has been marked.'}`,
    facts: { date: day(dayKey), present: s.Present + s.Late, absent: s.Absent, marked: s.schoolDays, percentage: s.percentage, notMarked: notMarked.slice(0, 12) },
    sources: [source('attendance', `Attendance · ${day(dayKey)}`)],
  };
}

async function run(ctx) {
  let out;
  if (ctx.students?.length) {
    const parts = [];
    for (const s of ctx.students) parts.push(await forStudent(ctx, s));
    out = { text: parts.map((p) => p.text).join('\n\n'), facts: { children: parts.map((p) => p.facts) }, sources: parts.flatMap((p) => p.sources) };
  } else if (ctx.role === 'teacher') out = await forTeacher(ctx);
  else if (ctx.role === 'admin') out = await forAdmin(ctx);
  else out = { noData: true, text: 'I could not find a student record linked to your account. Please ask the school office to link it.' };
  return { ...out, link: link('attendance', ctx.role) };
}

module.exports = { run, needsStudent: true, staffCanName: true };
