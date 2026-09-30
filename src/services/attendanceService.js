const Attendance = require('../models/Attendance');
const Student = require('../models/Student');
const { HttpError } = require('../utils/http');
const { toDayKey, formatDay } = require('../utils/dates');
const { parseClassKey, teacherCoversClass } = require('../utils/classes');
const { notifyParents } = require('./notify');

const STATUSES = ['Present', 'Absent', 'Late', 'Leave', 'Holiday'];

// Saves attendance for a class on one day. Re-saving the same day updates records
// (idempotent). Parents are notified only when a child's status becomes Absent/Late.
async function saveClassAttendance({ user, school, teacher, date, cls, section, records }) {
  const day = toDayKey(date);
  if (!day) throw new HttpError(400, 'Invalid date');
  if (day > toDayKey(new Date())) throw new HttpError(400, 'Attendance cannot be marked for a future date');
  const key = parseClassKey(cls, section);
  if (!key.class || !key.section) throw new HttpError(400, 'Class and section are required');
  if (!Array.isArray(records) || !records.length) throw new HttpError(400, 'At least one attendance record is required');
  if (user.role === 'teacher' && !teacherCoversClass(teacher, key.class, key.section)) {
    throw new HttpError(403, 'You are not assigned to this class');
  }

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

  const previous = await Attendance.find({ studentId: { $in: students.map((s) => s._id) }, date: day });
  const prevStatus = new Map(previous.map((p) => [String(p.studentId), p.status]));

  await Attendance.bulkWrite(normalized.map((r) => ({
    updateOne: {
      filter: { studentId: r.studentId, date: day },
      update: {
        $set: { status: r.status, remarks: r.remarks, markedBy: user._id, class: key.class, section: key.section, school },
      },
      upsert: true,
    },
  })));

  let notified = 0;
  for (const r of normalized) {
    if ((r.status === 'Absent' || r.status === 'Late') && prevStatus.get(r.studentId) !== r.status) {
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
