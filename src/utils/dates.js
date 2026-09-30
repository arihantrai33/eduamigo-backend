// Schools run on the Indian calendar day. Attendance and other "per day" records
// are stored as midnight UTC of that calendar date, so "2026-10-01" is the same
// key no matter which server timezone the code runs in.

const SCHOOL_TZ = process.env.SCHOOL_TIMEZONE || 'Asia/Kolkata';

function toDayKey(input) {
  if (typeof input === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input)) {
    const [y, m, d] = input.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d));
  }
  const date = input ? new Date(input) : new Date();
  if (Number.isNaN(date.getTime())) return null;
  // Take the calendar date as seen in the school's timezone.
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: SCHOOL_TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(date).split('-').map(Number);
  return new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
}

function formatDay(date) {
  return new Date(date).toISOString().slice(0, 10);
}

function daysBetweenInclusive(from, to) {
  const a = toDayKey(from);
  const b = toDayKey(to);
  return Math.round((b - a) / 86400000) + 1;
}

// Indian academic year runs April to March, e.g. "2026-27".
function currentAcademicYear(now = new Date()) {
  const today = toDayKey(now);
  const y = today.getUTCFullYear();
  const start = today.getUTCMonth() >= 3 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

module.exports = { SCHOOL_TZ, toDayKey, formatDay, daysBetweenInclusive, currentAcademicYear };
