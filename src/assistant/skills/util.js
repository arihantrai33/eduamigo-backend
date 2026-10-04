// Shared helpers for EduAmigo Ask skills.

const { toDayKey, currentAcademicYear } = require('../../utils/dates');
const { WEEKDAYS, DAY } = require('../entities');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ₹12,34,500 (Indian grouping); paise only when present.
function money(n) {
  const v = Math.round((Number(n) || 0) * 100) / 100;
  const [int, dec] = Math.abs(v).toFixed(2).split('.');
  const last3 = int.slice(-3);
  const rest = int.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return `${v < 0 ? '-' : ''}₹${rest ? `${rest},${last3}` : last3}${dec !== '00' ? `.${dec}` : ''}`;
}

// "15 Oct 2026" in the school's calendar; "15 Oct" when `short`.
function day(d, { short = false, weekday = false } = {}) {
  if (!d) return '';
  const k = toDayKey(d);
  const base = `${k.getUTCDate()} ${MONTHS[k.getUTCMonth()]}${short ? '' : ` ${k.getUTCFullYear()}`}`;
  return weekday ? `${WEEKDAYS[k.getUTCDay()].slice(0, 3)}, ${base}` : base;
}

const today = (now = new Date()) => toDayKey(now);
const addDays = (d, n) => new Date(toDayKey(d).getTime() + n * DAY);

// Start of the academic session (1 April by default) for "this year" questions.
function sessionStart(now = new Date(), startMonth = 4) {
  const y = Number(currentAcademicYear(now, startMonth).slice(0, 4));
  return new Date(Date.UTC(y, startMonth - 1, 1));
}

const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
const studentLabel = (s) => `${s.name} (${s.class}-${s.section})`;
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const listText = (items) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

// App screen for each role (frontend routes in App.jsx). Unknown role or screen gives null.
const SCREENS = {
  fees:       { student: '/student/fee', parent: '/parent/fee', admin: '/admin/fees', accountant: '/admin/fees' },
  attendance: { student: '/student/attendance', parent: '/parent/attendance', teacher: '/teacher/attendance', admin: '/admin/attendance-reports' },
  timetable:  { student: '/student/timetable', parent: '/parent/home', teacher: '/teacher/timetable', admin: '/admin/timetable' },
  results:    { student: '/student/result', parent: '/parent/result', teacher: '/teacher/marks', admin: '/admin/results' },
  exams:      { student: '/student/home', parent: '/parent/calendar', teacher: '/teacher/marks', admin: '/admin/exams' },
  notes:      { student: '/student/notes', teacher: '/teacher/upload' },
  transport:  { student: '/student/bus', parent: '/parent/bus', admin: '/admin/transport' },
  notices:    { student: '/student/notifications', parent: '/parent/notifications', teacher: '/teacher/notifications', admin: '/admin/communications', accountant: '/admin/communications' },
  events:     { parent: '/parent/calendar', admin: '/admin/event-calendar' },
  leave:      { student: '/student/apply-leave', parent: '/parent/apply-leave', teacher: '/teacher/leave', admin: '/admin/leaves' },
  hr:         { teacher: '/teacher/leave', admin: '/admin/hr-management' },
  library:    { admin: '/admin/library' },
  admissions: { admin: '/admin/admissions' },
};
const LINK_LABELS = {
  fees: 'Open fees', attendance: 'Open attendance', timetable: 'Open timetable', results: 'Open results', exams: 'Open exams',
  notes: 'Open study material', transport: 'Open bus', notices: 'Open notices', events: 'Open calendar', leave: 'Open leave',
  hr: 'Open HR', library: 'Open library', admissions: 'Open admissions',
};
function link(screen, role) {
  const path = SCREENS[screen]?.[role];
  return path ? { label: LINK_LABELS[screen], path } : null;
}

const source = (type, label, id) => ({ type, label, ...(id ? { id: String(id) } : {}) });

module.exports = { money, day, today, addDays, sessionStart, plural, studentLabel, escapeRegex, listText, link, source, MONTHS, DAY };
