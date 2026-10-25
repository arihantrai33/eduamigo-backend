const Attendance = require('../models/Attendance');
const Student = require('../models/Student');
const { HttpError } = require('../utils/http');
const { toDayKey, formatDay } = require('../utils/dates');
const { parseClassKey } = require('../utils/classes');
const { classScope, coversClass } = require('./scope');
const { notifyParents } = require('./notify');
const { mapLimit, isDuplicateKey } = require('../utils/concurrency');

const STATUSES = ['Present', 'Absent', 'Late', 'Leave', 'Holiday'];

// Creates or updates one attendance row and returns the row as it was before. When two saves create the same row at the
// same moment, the unique index rejects one of them; that one is simply repeated and then updates the existing row.
async function upsertRow(filter, update) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await Attendance.findOneAndUpdate(filter, update, { upsert: true, returnDocument: 'before', lean: true });
    } catch (err) {
      if (!isDuplicateKey(err) || attempt >= 3) throw err;
    }
  }
}

// Saves attendance for a class on one day. Re-saving the same day updates records
// (idempotent). Parents are notified only when a child's status becomes Absent/Late.
async function saveClassAttendance({ user, school, date, cls, section, records }) {
  const day = toDayKey(date);
  if (!day) throw new HttpError(400, 'Invalid date');
  if (day > toDayKey(new Date())) throw new HttpError(400, 'Attendance cannot be marked for a future date');
  const key = parseClassKey(cls, section);
  if (!key.class || !key.section) throw new HttpError(400, 'Class and section are required');
  if (!Array.isArray(records) || !records.length) throw new HttpError(400, 'At least one attendance record is required');
  // The school's staff with school-wide scope mark any class; a teacher only their assigned classes; anyone else nothing.
  if (!coversClass(await classScope(user, 'academic'), key.class, key.section)) throw new HttpError(403, 'You are not assigned to this class');

  const normalized = records.map((r) => ({
    studentId: String(r.studentId || r.student || ''),
    status: r.status || 'Present',
    remarks: r.remarks ? String(r.remarks).slice(0, 500) : '',
  }));
  const bad = normalized.find((r) => !STATUSES.includes(r.status));
  if (bad) throw new HttpError(400, `Invalid attendance status: ${bad.status}`);

  const students = await Student.find({
    _id: { $in: normalized.map((r) => r.studentId).filter((id) => /^[a-f\d]{24}$/i.test(id)) },
    school, class: key.class, section: key.section, isActive: true,
  });
  const byId = new Map(students.map((s) => [String(s._id), s]));
  const invalid = normalized.filter((r) => !byId.has(r.studentId));
  if (invalid.length) throw new HttpError(400, `${invalid.length} student(s) do not belong to ${key.class}-${key.section}`);

  // Each row is written with one atomic upsert that also returns what was there before. Two saves of the same class and
  // day at the same moment therefore cannot both see "no previous status", so a parent is told once per change.
  const before = await mapLimit(normalized, 10, (r) => upsertRow(
    { school, studentId: r.studentId, date: day },
    { $set: { status: r.status, remarks: r.remarks, markedBy: user._id, class: key.class, section: key.section, school } },
  ));

  let notified = 0;
  for (const [i, r] of normalized.entries()) {
    if ((r.status === 'Absent' || r.status === 'Late') && before[i]?.status !== r.status) {
      const student = byId.get(r.studentId);
      notified += await notifyParents(student, {
        title: `Attendance: ${r.status}`,
        message: `${student.name} was marked ${r.status} on ${formatDay(day)}.`,
        type: 'Attendance',
        createdBy: user._id,
      });
    }
  }
  return { count: normalized.length, notified, date: formatDay(day) };
}

// Holidays are excluded; Late counts as attended.
function summarizeCounts(c) {
  const present = c.Present || 0;
  const late = c.Late || 0;
  const absent = c.Absent || 0;
  const leave = c.Leave || 0;
  const holiday = c.Holiday || 0;
  const workingDays = present + late + absent + leave;
  const percentage = workingDays > 0 ? Math.round(((present + late) / workingDays) * 1000) / 10 : 0;
  return { total: workingDays, present, absent, late, leave, holiday, percentage };
}

function summarize(records) {
  const counts = {};
  for (const r of records) counts[r.status] = (counts[r.status] || 0) + 1;
  return summarizeCounts(counts);
}

module.exports = { saveClassAttendance, summarize, summarizeCounts, STATUSES };
