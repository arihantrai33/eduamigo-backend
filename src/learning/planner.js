// Revision Planner: a day-by-day plan from the exam date, the topics the student lists, and the minutes a day they have.
// Deterministic (no model): the same input gives the same plan, and nothing is invented.
//   - The exam date is one the student typed or one from the school's exam schedule (ExamSchedule); never guessed.
//   - Topics weak in Practice & Assessment come first and get an extra practice session; the reason is shown.
//   - Each topic: a study session, then a practice session two or three days later when there is room; the last day before
//     the exam is a review day.
//   - When the time is too short, practice sessions go first, then study sessions are shortened to 20 minutes; anything that
//     still does not fit is named in the warnings, never silently dropped.

const ExamSchedule = require('../models/ExamSchedule');
const PracticeSession = require('../models/PracticeSession');
const { HttpError } = require('../utils/http');
const { toDayKey, formatDay } = require('../utils/dates');

const DAY = 86400000;
const STUDY_MIN = 45;
const SHORT_STUDY_MIN = 20;
const PRACTICE_MIN = 20;
const REVIEW_MIN = 60;
const MAX_TOPICS = 40;
const MAX_DAYS = 365;

async function upcomingExams({ schoolId, cls, section }) {
  const rows = await ExamSchedule.find({ school: schoolId, class: String(cls), section: { $in: ['', section || ''] }, date: { $gte: toDayKey() } })
    .sort({ date: 1 }).limit(20).select('title subject date examType').lean();
  return rows.map((r) => ({ _id: String(r._id), title: r.title, subject: r.subject, date: formatDay(r.date), examType: r.examType }));
}

// Accuracy by subject and topic from the student's practice answers: { "Maths|Fractions": { right, total } }.
async function practiceAccuracy({ schoolId, userId }) {
  const sessions = await PracticeSession.find({ school: schoolId, user: userId }).select('subject topic questions.id questions.topic attempts').lean();
  const stats = {};
  for (const s of sessions) {
    const topicOf = new Map(s.questions.map((q) => [q.id, q.topic || s.topic]));
    for (const a of s.attempts) {
      if (a.verdict === 'revealed') continue;
      const key = `${s.subject}|${topicOf.get(a.questionId) || s.topic || ''}`.toLowerCase();
      stats[key] = stats[key] || { right: 0, total: 0 };
      stats[key].total += 1;
      if (a.verdict === 'correct') stats[key].right += 1;
      else if (a.verdict === 'partly') stats[key].right += 0.5;
    }
  }
  return stats;
}

const cleanTopics = (topics) => {
  const seen = new Set();
  return (Array.isArray(topics) ? topics : []).map((t) => ({ subject: String(t?.subject || '').trim().slice(0, 40), topic: String(t?.topic || '').trim().slice(0, 120) }))
    .filter((t) => t.subject && t.topic && !seen.has(`${t.subject}|${t.topic}`.toLowerCase()) && seen.add(`${t.subject}|${t.topic}`.toLowerCase()));
};

// Builds the plan. input: { examDate?: 'YYYY-MM-DD', examId?, topics: [{subject, topic}], minutesPerDay, restDays?: [0..6], startDate? }
async function buildPlan({ schoolId, userId, student, input, now = new Date() }) {
  let examDate = null;
  let examSource = 'student';
  let title = 'Revision plan';
  if (input.examId) {
    const exam = await ExamSchedule.findOne({ _id: input.examId, school: schoolId, class: String(student.class), section: { $in: ['', student.section || ''] } }).lean();
    if (!exam) throw new HttpError(404, 'That exam is not in your class\'s exam schedule');
    examDate = toDayKey(exam.date);
    examSource = 'school';
    title = `${exam.title} (${exam.subject})`;
  } else if (input.examDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(input.examDate))) throw new HttpError(400, 'Exam date must be a date (YYYY-MM-DD)');
    examDate = toDayKey(String(input.examDate));
    if (formatDay(examDate) !== String(input.examDate)) throw new HttpError(400, 'Exam date is not a valid date');
    if (input.examName) title = String(input.examName).trim().slice(0, 100) || title;
  } else {
    throw new HttpError(400, 'Choose an exam from your school\'s schedule or enter your exam date');
  }
  const today = toDayKey(now);
  const start = input.startDate ? toDayKey(String(input.startDate)) : today;
  if (!start || start < today) throw new HttpError(400, 'The plan cannot start in the past');
  if (examDate <= start) throw new HttpError(400, 'The exam date must be after the first day of the plan');
  if ((examDate - start) / DAY > MAX_DAYS) throw new HttpError(400, 'Plans can cover at most one year');

  const minutesPerDay = Math.round(Number(input.minutesPerDay));
  if (!Number.isFinite(minutesPerDay) || minutesPerDay < 15 || minutesPerDay > 480) throw new HttpError(400, 'Choose between 15 minutes and 8 hours a day');
  const restDays = [...new Set((Array.isArray(input.restDays) ? input.restDays : []).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))];
  if (restDays.length === 7) throw new HttpError(400, 'Leave at least one study day in the week');
  const topics = cleanTopics(input.topics);
  if (!topics.length) throw new HttpError(400, 'Add at least one topic to revise');
  if (topics.length > MAX_TOPICS) throw new HttpError(400, `Add at most ${MAX_TOPICS} topics`);

  // Study days before the exam (the exam day itself is not a study day).
  const days = [];
  for (let d = start.getTime(); d < examDate.getTime(); d += DAY) if (!restDays.includes(new Date(d).getUTCDay())) days.push(new Date(d));
  if (!days.length) throw new HttpError(400, 'There are no study days before the exam with these rest days');

  // Weak topics first (practice accuracy under 60% with at least 3 answers), then the order the student gave.
  const stats = await practiceAccuracy({ schoolId, userId });
  const ranked = topics.map((t, i) => {
    const s = stats[`${t.subject}|${t.topic}`.toLowerCase()];
    const acc = s && s.total >= 3 ? s.right / s.total : null;
    return { ...t, order: i, weak: acc !== null && acc < 0.6, reasonWeak: acc !== null && acc < 0.6 ? `Weak in practice: ${s.right} of ${s.total} correct` : null };
  }).sort((a, b) => Number(b.weak) - Number(a.weak) || a.order - b.order);

  const warnings = [];
  const reviewDay = days.length > 1 ? days[days.length - 1] : null;
  const studyDays = reviewDay ? days.slice(0, -1) : days;
  const capacity = studyDays.length * minutesPerDay;
  const want = (studyMin, withPractice) => ranked.reduce((a, t) => a + studyMin + (withPractice ? PRACTICE_MIN * (t.weak ? 2 : 1) : 0), 0);
  let studyMinutes = STUDY_MIN;
  let practice = true;
  if (want(STUDY_MIN, true) > capacity) {
    practice = false;
    if (want(STUDY_MIN, false) > capacity) studyMinutes = SHORT_STUDY_MIN;
    warnings.push(studyMinutes === SHORT_STUDY_MIN
      ? 'There is not enough time for full sessions: each topic gets a short 20-minute study session and no separate practice.'
      : 'There is not enough time for separate practice sessions: each topic gets one study session.');
  }

  const used = new Map(); // day index -> minutes used
  const items = [];
  const place = (fromIdx, minutes) => {
    for (let i = Math.max(0, fromIdx); i < studyDays.length; i += 1) {
      if ((used.get(i) || 0) + minutes <= minutesPerDay) { used.set(i, (used.get(i) || 0) + minutes); return i; }
    }
    return -1;
  };
  const notFitted = [];
  let cursor = 0;
  ranked.forEach((t) => {
    const at = place(cursor, studyMinutes);
    if (at < 0) { notFitted.push(`${t.subject}: ${t.topic}`); return; }
    items.push({ subject: t.subject, topic: t.topic, minutes: studyMinutes, date: studyDays[at], kind: 'study', reason: t.reasonWeak });
    // Spread topics over the days instead of piling them on the first one.
    cursor = Math.min(studyDays.length - 1, at + (ranked.length >= studyDays.length ? 0 : 1));
    if (practice) {
      for (let k = 0; k < (t.weak ? 2 : 1); k += 1) {
        const p = place(Math.min(studyDays.length - 1, at + 2 + k * 2), PRACTICE_MIN);
        const where = p >= 0 ? p : place(at, PRACTICE_MIN);
        if (where >= 0) items.push({ subject: t.subject, topic: t.topic, minutes: PRACTICE_MIN, date: studyDays[where], kind: 'practice', reason: t.reasonWeak });
      }
    }
  });
  if (notFitted.length) warnings.push(`These topics did not fit before the exam with ${minutesPerDay} minutes a day: ${notFitted.join('; ')}. Add more time a day or fewer rest days.`);
  if (reviewDay) items.push({ subject: 'All subjects', topic: 'Final review of all topics', minutes: Math.min(REVIEW_MIN, minutesPerDay), date: reviewDay, kind: 'review', reason: 'The last day before the exam' });
  else warnings.push('The exam is tomorrow: there is no separate review day.');

  items.sort((a, b) => a.date - b.date || ['study', 'practice', 'review'].indexOf(a.kind) - ['study', 'practice', 'review'].indexOf(b.kind));
  return {
    title, examDate, examSource, startDate: start, minutesPerDay, restDays,
    items: items.map((it, i) => ({ id: `i${i + 1}`, ...it })),
    warnings,
  };
}

module.exports = { buildPlan, upcomingExams, practiceAccuracy };
