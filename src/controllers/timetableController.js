const Timetable = require('../models/Timetable');
const Teacher = require('../models/Teacher');
const { HttpError, asyncHandler, assertId } = require('../utils/http');
const { parseClassKey } = require('../utils/classes');
const { studentForUser } = require('../services/directory');

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
// Accepts "Thursday", "thursday" or "Thu"; returns the stored day name or null.
const dayName = (value) => DAYS.find((d) => d.toLowerCase().startsWith(String(value || '').trim().toLowerCase().slice(0, 3)) && String(value || '').trim().length >= 3) || null;
const byDay = (a, b) => DAYS.indexOf(a.day) - DAYS.indexOf(b.day);

async function validatePeriods(school, periods) {
  if (!Array.isArray(periods)) return [];
  const teacherIds = [...new Set(periods.map((p) => p.teacher).filter(Boolean).map(String))];
  teacherIds.forEach((id) => assertId(id, 'teacher'));
  const count = await Teacher.countDocuments({ _id: { $in: teacherIds }, school });
  if (count !== teacherIds.length) throw new HttpError(400, 'One or more teachers do not belong to your school');
  return periods.map((p) => ({
    no: p.no ?? p.periodNo, periodNo: p.periodNo ?? p.no, subject: p.subject,
    teacher: p.teacher || undefined, time: p.time, startTime: p.startTime, endTime: p.endTime,
  }));
}

// Merges one period into a list, replacing any existing period with the same number.
function mergePeriod(periods, period) {
  const no = Number(period.no ?? period.periodNo);
  if (!(no >= 1)) throw new HttpError(400, 'Period number is required');
  const rest = (periods || []).filter((p) => Number(p.no ?? p.periodNo) !== no);
  return [...rest, { ...period, no, periodNo: no }].sort((a, b) => Number(a.no ?? a.periodNo) - Number(b.no ?? b.periodNo));
}

// GET /api/timetable?class=&section= (admin) — all timetables in the school
const listTimetables = asyncHandler(async (req, res) => {
  const filter = { school: req.schoolId };
  if (req.query.class) {
    const key = parseClassKey(req.query.class, req.query.section);
    filter.class = key.class;
    if (key.section) filter.section = key.section;
  }
  const timetables = (await Timetable.find(filter).populate('periods.teacher', 'name subjects')).sort(byDay);
  res.json({ success: true, data: timetables });
});

// POST /api/timetable  { class, section, day, periods?: [...], period?: {...} }
const createTimetable = asyncHandler(async (req, res) => {
  const { day } = req.body || {};
  const key = parseClassKey(req.body?.class, req.body?.section);
  if (!key.class || !key.section || !DAYS.includes(day)) throw new HttpError(400, 'Class, section and a valid day are required');
  const existing = await Timetable.findOne({ school: req.schoolId, class: key.class, section: key.section, day });
  if (existing) throw new HttpError(409, 'A timetable for this class and day already exists');
  const input = req.body.period ? [req.body.period] : req.body.periods;
  const periods = await validatePeriods(req.schoolId, input);
  const timetable = await Timetable.create({ school: req.schoolId, class: key.class, section: key.section, day, periods, classTeacher: req.body.classTeacher || undefined });
  res.status(201).json({ success: true, message: 'Timetable created successfully', data: timetable });
});

// GET /api/timetable/class/:class?section=A
const getClassTimetable = asyncHandler(async (req, res) => {
  const key = parseClassKey(req.params.class, req.query.section);
  const filter = { school: req.schoolId, class: key.class };
  if (key.section) filter.section = key.section;
  const timetable = (await Timetable.find(filter).populate('periods.teacher', 'name subjects')).sort(byDay);
  res.json({ success: true, data: timetable });
});

const getClassDayTimetable = asyncHandler(async (req, res) => {
  const key = parseClassKey(req.params.class, req.query.section);
  const filter = { school: req.schoolId, class: key.class, day: req.params.day };
  if (key.section) filter.section = key.section;
  const timetable = await Timetable.findOne(filter).populate('periods.teacher', 'name subjects');
  if (!timetable) throw new HttpError(404, 'Timetable not found');
  res.json({ success: true, data: timetable });
});

const getTeacherTimetable = asyncHandler(async (req, res) => {
  assertId(req.params.teacherId, 'teacherId');
  const timetable = (await Timetable.find({ school: req.schoolId, 'periods.teacher': req.params.teacherId })).sort(byDay);
  // One entry per day with every period this teacher takes, across all classes, in time order.
  const byDayName = new Map();
  for (const d of timetable) {
    const periods = d.periods
      .filter((p) => p.teacher && String(p.teacher) === String(req.params.teacherId))
      .map((p) => ({ ...p.toJSON(), class: d.class, section: d.section }));
    if (!byDayName.has(d.day)) byDayName.set(d.day, { day: d.day, periods: [] });
    byDayName.get(d.day).periods.push(...periods);
  }
  const data = [...byDayName.values()].map((d) => ({
    ...d,
    periods: d.periods.sort((a, b) => String(a.startTime || a.time || '').localeCompare(String(b.startTime || b.time || '')) || (a.no || 0) - (b.no || 0)),
  }));
  res.json({ success: true, data });
});

const getMyTimetable = asyncHandler(async (req, res) => {
  const student = await studentForUser(req.user);
  if (!student) throw new HttpError(404, 'Student not found');
  const filter = { school: req.schoolId, class: student.class, section: student.section };
  if (req.query.day) {
    const day = dayName(req.query.day);
    if (!day) return res.json({ success: true, data: [] }); // Sunday or an unknown day: no classes
    filter.day = day;
  }
  const timetable = (await Timetable.find(filter).populate('periods.teacher', 'name')).sort(byDay);
  if (req.query.day) return res.json({ success: true, data: timetable[0]?.periods || [] });
  res.json({ success: true, data: timetable });
});

const updateTimetable = asyncHandler(async (req, res) => {
  assertId(req.params.id);
  const update = {};
  if (req.body?.periods !== undefined) update.periods = await validatePeriods(req.schoolId, req.body.periods);
  if (req.body?.period) {
    const current = await Timetable.findOne({ _id: req.params.id, school: req.schoolId });
    if (!current) throw new HttpError(404, 'Timetable not found');
    const [period] = await validatePeriods(req.schoolId, [req.body.period]);
    update.periods = mergePeriod(current.periods.map((p) => p.toObject()), period);
  }
  if (req.body?.classTeacher) update.classTeacher = req.body.classTeacher;
  if (req.body?.day) {
    if (!DAYS.includes(req.body.day)) throw new HttpError(400, 'Invalid day');
    update.day = req.body.day;
  }
  const timetable = await Timetable.findOneAndUpdate({ _id: req.params.id, school: req.schoolId }, { $set: update }, { returnDocument: 'after', runValidators: true });
  if (!timetable) throw new HttpError(404, 'Timetable not found');
  res.json({ success: true, message: 'Timetable updated successfully', data: timetable });
});

const deleteTimetable = asyncHandler(async (req, res) => {
  assertId(req.params.id);
  const timetable = await Timetable.findOneAndDelete({ _id: req.params.id, school: req.schoolId });
  if (!timetable) throw new HttpError(404, 'Timetable not found');
  res.json({ success: true, message: 'Timetable deleted successfully' });
});

module.exports = {
  listTimetables,
  createTimetable, getClassTimetable, getClassDayTimetable, getTeacherTimetable,
  getMyTimetable, updateTimetable, deleteTimetable,
};
