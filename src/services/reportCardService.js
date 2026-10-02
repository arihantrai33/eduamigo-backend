// Builds report cards from published results (ExamResult), attendance and teacher remarks.
// A term card has one column per exam in that term; the full-year card has one column per term.
const ExamResult = require('../models/ExamResult');
const Attendance = require('../models/Attendance');
const ReportCardRemark = require('../models/ReportCardRemark');
const School = require('../models/School');
const { percentage, gradeFor } = require('../utils/grades');
const { summarizeCounts } = require('./attendanceService');
const { termForDate, TERMS } = require('../config/exams');
const { toDayKey } = require('../utils/dates');

const PASS_PERCENT = 33;
const PERIODS = [...TERMS, 'Full Year'];

// Calendar window of a term inside an academic year such as "2026-27".
function termWindow(academicYear, term) {
  const start = Number(String(academicYear).slice(0, 4));
  if (term === 'Term 1') return { from: new Date(Date.UTC(start, 3, 1)), to: new Date(Date.UTC(start, 9, 1)) };
  if (term === 'Term 2') return { from: new Date(Date.UTC(start, 9, 1)), to: new Date(Date.UTC(start + 1, 3, 1)) };
  return { from: new Date(Date.UTC(start, 3, 1)), to: new Date(Date.UTC(start + 1, 3, 1)) };
}

const round1 = (n) => Math.round(n * 10) / 10;
const termOf = (r) => r.term || (r.examDate ? termForDate(r.examDate) : null);

function buildCard(student, results, term) {
  const inScope = results.filter((r) => term === 'Full Year' || termOf(r) === term);

  // Columns: exams in date order (term card) or the two terms (full-year card).
  let columns;
  if (term === 'Full Year') columns = TERMS.map((t) => ({ key: t, label: t }));
  else {
    const seen = new Map();
    for (const r of [...inScope].sort((a, b) => new Date(a.examDate || a.createdAt) - new Date(b.examDate || b.createdAt))) {
      if (!seen.has(r.examName)) seen.set(r.examName, { key: r.examName, label: r.examName, examType: r.examType });
    }
    columns = [...seen.values()];
  }

  const bySubject = new Map();
  for (const r of inScope) {
    const col = term === 'Full Year' ? termOf(r) : r.examName;
    if (!col) continue;
    if (!bySubject.has(r.subject)) bySubject.set(r.subject, {});
    const cells = bySubject.get(r.subject);
    const cell = cells[col] || { obtained: 0, max: 0, absent: true, papers: 0 };
    cell.obtained += r.absent ? 0 : r.marksObtained;
    cell.max += r.totalMarks;
    cell.absent = cell.absent && !!r.absent;
    cell.papers += 1;
    cells[col] = cell;
  }

  const subjects = [...bySubject.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([subject, cells]) => {
    const obtained = Object.values(cells).reduce((s, c) => s + c.obtained, 0);
    const max = Object.values(cells).reduce((s, c) => s + c.max, 0);
    const pct = percentage(obtained, max);
    for (const c of Object.values(cells)) {
      c.percentage = percentage(c.obtained, c.max);
      c.grade = c.absent ? 'AB' : gradeFor(c.percentage);
    }
    return { subject, cells, obtained: round1(obtained), max, percentage: pct, grade: gradeFor(pct), passed: pct >= PASS_PERCENT };
  });

  const obtained = subjects.reduce((s, x) => s + x.obtained, 0);
  const max = subjects.reduce((s, x) => s + x.max, 0);
  const pct = percentage(obtained, max);
  const below = subjects.filter((s) => !s.passed).map((s) => s.subject);
  return {
    student: {
      _id: student._id, name: student.name, rollNumber: student.rollNumber, class: student.class, section: student.section,
      dateOfBirth: student.dateOfBirth, parentName: student.parentName,
    },
    columns,
    subjects,
    totals: {
      obtained: round1(obtained), max, percentage: pct, grade: subjects.length ? gradeFor(pct) : null,
      result: !subjects.length ? null : below.length ? 'Below passing marks' : 'Pass', belowIn: below,
    },
  };
}

// Report cards for a list of students of one school (usually one class-section).
async function buildReportCards({ schoolId, students, term, academicYear }) {
  if (!PERIODS.includes(term)) throw Object.assign(new Error('Term must be Term 1, Term 2 or Full Year'), { status: 400 });
  const ids = students.map((s) => s._id);
  const window = termWindow(academicYear, term);
  const today = toDayKey(new Date());
  const [school, results, attendance, remarks] = await Promise.all([
    School.findById(schoolId).select('name address phone email principal'),
    ExamResult.find({ school: schoolId, student: { $in: ids }, academicYear }).lean(),
    Attendance.find({ school: schoolId, studentId: { $in: ids }, date: { $gte: window.from, $lt: window.to } }).select('studentId status').lean(),
    ReportCardRemark.find({ school: schoolId, student: { $in: ids }, academicYear, term }).lean(),
  ]);

  const resultsBy = new Map(ids.map((id) => [String(id), []]));
  results.forEach((r) => resultsBy.get(String(r.student))?.push(r));
  const attendanceBy = new Map();
  for (const a of attendance) {
    const k = String(a.studentId);
    if (!attendanceBy.has(k)) attendanceBy.set(k, {});
    const c = attendanceBy.get(k);
    c[a.status] = (c[a.status] || 0) + 1;
  }
  const remarksBy = new Map(remarks.map((r) => [String(r.student), r.remarks]));

  const cards = students.map((s) => {
    const card = buildCard(s, resultsBy.get(String(s._id)) || [], term);
    const att = summarizeCounts(attendanceBy.get(String(s._id)) || {});
    card.attendance = { present: att.present + att.late, workingDays: att.total, percentage: att.total ? att.percentage : null };
    card.remarks = remarksBy.get(String(s._id)) || '';
    return card;
  });

  // Rank within the group by overall percentage (students with results only; equal scores share a rank).
  const ranked = cards.filter((c) => c.subjects.length).sort((a, b) => b.totals.percentage - a.totals.percentage);
  ranked.forEach((c, i) => {
    c.rank = i > 0 && c.totals.percentage === ranked[i - 1].totals.percentage ? ranked[i - 1].rank : i + 1;
  });
  cards.forEach((c) => { c.classSize = students.length; c.rank = c.rank || null; });

  return {
    school: school ? { name: school.name, address: school.address, phone: school.phone, email: school.email, principal: school.principal } : null,
    academicYear, term, generatedOn: today, cards,
  };
}

module.exports = { buildReportCards, termWindow, PERIODS };
