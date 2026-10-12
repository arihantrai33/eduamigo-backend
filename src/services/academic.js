// School structure: sessions, the class/section/subject master, admission and roll numbers,
// and each student's year-by-year enrollment history.
//
// Backwards compatible by design: until a school creates sessions or classes, the old behaviour
// applies (session worked out from the date, any class/section accepted).

const AcademicSession = require('../models/AcademicSession');
const SchoolClass = require('../models/SchoolClass');
const StudentEnrollment = require('../models/StudentEnrollment');
const Student = require('../models/Student');
const School = require('../models/School');
const Counter = require('../models/Counter');
const { HttpError } = require('../utils/http');
const { currentAcademicYear } = require('../utils/dates');
const { normalizeClass, normalizeSection, classKey } = require('../utils/classes');

// ---------------- Sessions ----------------

async function sessionStartMonth(schoolId) {
  const school = await School.findById(schoolId).select('academic').lean();
  return school?.academic?.sessionStartMonth || 4;
}

const currentSession = (schoolId) => AcademicSession.findOne({ school: schoolId, status: 'current' });

// Name of the school's current session, e.g. "2026-27".
async function currentSessionName(schoolId, now = new Date()) {
  const current = await currentSession(schoolId).select('name').lean();
  return current?.name || currentAcademicYear(now, await sessionStartMonth(schoolId));
}

// Session a date belongs to (for fees, exams and leave by date).
async function sessionNameForDate(schoolId, date) {
  const d = new Date(date);
  const hit = await AcademicSession.findOne({ school: schoolId, startDate: { $lte: d }, endDate: { $gte: d } }).select('name').lean();
  return hit?.name || currentAcademicYear(d, await sessionStartMonth(schoolId));
}

// Default dates for a session name using the school's start month: "2026-27" -> 1 Apr 2026 to 31 Mar 2027.
function defaultSessionDates(name, startMonth = 4) {
  const startYear = Number(String(name).slice(0, 4));
  const startDate = new Date(Date.UTC(startYear, startMonth - 1, 1));
  const endDate = new Date(Date.UTC(startYear + 1, startMonth - 1, 1) - 1);
  return { startDate, endDate };
}

async function createSession(schoolId, { name, startDate, endDate, makeCurrent = false }) {
  name = String(name || '').trim();
  if (!/^\d{4}-\d{2}$/.test(name) || (Number(name.slice(0, 4)) + 1) % 100 !== Number(name.slice(5))) {
    throw new HttpError(400, 'Session name must look like 2026-27');
  }
  const defaults = defaultSessionDates(name, await sessionStartMonth(schoolId));
  const start = startDate ? new Date(startDate) : defaults.startDate;
  const end = endDate ? new Date(endDate) : defaults.endDate;
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) throw new HttpError(400, 'End date must be after start date');
  if (await AcademicSession.exists({ school: schoolId, name })) throw new HttpError(409, `Session ${name} already exists`);
  const overlap = await AcademicSession.findOne({ school: schoolId, startDate: { $lte: end }, endDate: { $gte: start } }).select('name');
  if (overlap) throw new HttpError(409, `Dates overlap with session ${overlap.name}`);

  const session = await AcademicSession.create({ school: schoolId, name, startDate: start, endDate: end });
  if (makeCurrent || !(await currentSession(schoolId))) return setCurrentSession(schoolId, session._id);
  return session;
}

// Makes a session current. The previous current session is closed.
async function setCurrentSession(schoolId, sessionId) {
  const session = await AcademicSession.findOne({ _id: sessionId, school: schoolId });
  if (!session) throw new HttpError(404, 'Session not found');
  if (session.status === 'current') return session;
  await AcademicSession.updateMany({ school: schoolId, status: 'current' }, { status: 'closed' });
  session.status = 'current';
  await session.save();
  return session;
}

// ---------------- Classes and sections ----------------

const SPECIAL_ORDER = { PLAYGROUP: -4, NURSERY: -3, PREP: -3, LKG: -2, KG: -2, UKG: -1 };

function defaultClassOrder(name) {
  const upper = String(name).toUpperCase().trim();
  if (SPECIAL_ORDER[upper] !== undefined) return SPECIAL_ORDER[upper];
  const n = parseInt(upper, 10);
  return Number.isNaN(n) ? 100 : n;
}

const sortClasses = (a, b) => (a.order - b.order) || String(a.name).localeCompare(String(b.name), 'en', { numeric: true });

async function listClasses(schoolId, { includeInactive = false } = {}) {
  const filter = { school: schoolId };
  if (!includeInactive) filter.isActive = true;
  const classes = await SchoolClass.find(filter).lean();
  return classes.sort(sortClasses);
}

const hasClassMaster = (schoolId) => SchoolClass.exists({ school: schoolId, isActive: true });

// Rejects a class/section that is not in the school's class list (only once the school has one).
async function assertClassSection(schoolId, cls, section) {
  if (!(await hasClassMaster(schoolId))) return;
  const c = normalizeClass(cls);
  const s = normalizeSection(section);
  const found = await SchoolClass.findOne({ school: schoolId, name: c, isActive: true }).select('sections').lean();
  if (!found) throw new HttpError(400, `Class ${c} is not in your class list. Add it under Classes & Sections first.`);
  if (s && !found.sections.some((x) => x.name === s)) {
    throw new HttpError(400, `Section ${s} does not exist in Class ${c}. Add it under Classes & Sections first.`);
  }
}

function cleanSections(input) {
  if (!Array.isArray(input)) return undefined;
  const seen = new Set();
  const sections = [];
  for (const raw of input) {
    const name = normalizeSection(typeof raw === 'string' ? raw : raw?.name);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    sections.push({
      name,
      classTeacher: (typeof raw === 'object' && raw?.classTeacher) || null,
      capacity: (typeof raw === 'object' && raw?.capacity) || null,
    });
  }
  return sections;
}

function cleanSubjects(input) {
  if (!Array.isArray(input)) return undefined;
  return [...new Set(input.map((s) => String(s || '').trim()).filter(Boolean))];
}

// Builds the class list from classes and sections that existing students are already in.
async function importClassesFromStudents(schoolId) {
  const pairs = await Student.aggregate([
    { $match: { school: schoolId, isActive: true } },
    { $group: { _id: { class: '$class', section: '$section' } } },
  ]);
  const byClass = new Map();
  for (const { _id } of pairs) {
    const c = normalizeClass(_id.class);
    const s = normalizeSection(_id.section);
    if (!c) continue;
    if (!byClass.has(c)) byClass.set(c, new Set());
    if (s) byClass.get(c).add(s);
  }
  const school = await School.findById(schoolId).select('customSubjects').lean();
  let created = 0;
  let updated = 0;
  for (const [name, sections] of byClass) {
    const existing = await SchoolClass.findOne({ school: schoolId, name });
    if (!existing) {
      await SchoolClass.create({
        school: schoolId, name, displayName: `Class ${name}`, order: defaultClassOrder(name),
        sections: [...sections].sort().map((s) => ({ name: s })), subjects: school?.customSubjects || [],
      });
      created += 1;
    } else {
      const missing = [...sections].filter((s) => !existing.sections.some((x) => x.name === s));
      if (missing.length) {
        existing.sections.push(...missing.map((s) => ({ name: s })));
        await existing.save();
        updated += 1;
      }
    }
  }
  return { created, updated };
}

// ---------------- Admission and roll numbers ----------------

async function nextAdmissionNo(schoolId) {
  const school = await School.findById(schoolId).select('academic').lean();
  const prefix = school?.academic?.admissionNoPrefix || '';
  for (let i = 0; i < 100; i += 1) {
    const candidate = `${prefix}${await Counter.next(schoolId, 'admissionNo')}`;
    if (!(await Student.exists({ school: schoolId, admissionNo: candidate }))) return candidate;
  }
  throw new HttpError(500, 'Could not assign an admission number');
}

async function nextRollNumber(schoolId, cls, section) {
  const rolls = await Student.find({ school: schoolId, class: cls, section, isActive: true }).select('rollNumber').lean();
  return String(rolls.reduce((m, s) => Math.max(m, Number(s.rollNumber) || 0), 0) + 1);
}

// ---------------- Enrollment history ----------------

// Records (or updates) where the student studies in the current session.
async function recordPlacement(student, { session } = {}) {
  const name = session || await currentSessionName(student.school);
  await StudentEnrollment.updateOne(
    { school: student.school, student: student._id, session: name },
    {
      $set: { school: student.school, class: student.class, section: student.section, rollNumber: student.rollNumber || '' },
      $setOnInsert: { status: 'studying', startedAt: new Date() },
    },
    { upsert: true },
  );
}

// Ends the student's open enrollment (left school, graduated...).
async function closeEnrollment(student, status, note = '') {
  await StudentEnrollment.updateMany(
    { school: student.school, student: student._id, status: 'studying' },
    { $set: { status, endedAt: new Date(), note } },
  );
}

// Moves students to another class: within the same session it is a correction of the current
// enrollment; into another session the old enrollment is marked promoted and a new one is opened.
async function movePlacement(students, { toSession, status = 'promoted' } = {}) {
  const now = new Date();
  for (const student of students) {
    const open = await StudentEnrollment.findOne({ school: student.school, student: student._id, status: 'studying' }).sort({ startedAt: -1 });
    const target = toSession || await currentSessionName(student.school);
    if (open && open.session !== target) {
      open.status = status;
      open.endedAt = now;
      await open.save();
    }
    await recordPlacement(student, { session: target });
  }
}

// ---------------- Setup checklist ----------------

async function setupStatus(schoolId, features = []) {
  const Teacher = require('../models/Teacher');
  const Timetable = require('../models/Timetable');
  const FeeStructure = require('../models/FeeStructure');
  const [session, classes, teachers, students, timetables, feeStructures] = await Promise.all([
    currentSession(schoolId).lean(),
    listClasses(schoolId),
    Teacher.countDocuments({ school: schoolId, isActive: { $ne: false } }),
    Student.countDocuments({ school: schoolId, isActive: true }),
    Timetable.countDocuments({ school: schoolId }),
    features.includes('fees') ? FeeStructure.countDocuments({ school: schoolId }) : Promise.resolve(null),
  ]);
  const sections = classes.flatMap((c) => c.sections);
  const steps = [
    { key: 'session', label: 'Create the academic session', done: !!session },
    { key: 'classes', label: 'Add classes and sections', done: sections.length > 0 },
    { key: 'subjects', label: 'Add subjects to every class', done: classes.length > 0 && classes.every((c) => c.subjects.length > 0) },
    { key: 'teachers', label: 'Add teachers', done: teachers > 0 },
    { key: 'classTeachers', label: 'Assign class teachers', done: sections.length > 0 && sections.every((s) => s.classTeacher) },
    { key: 'students', label: 'Add or import students', done: students > 0 },
    { key: 'timetable', label: 'Create timetables', done: timetables > 0 },
  ];
  if (feeStructures !== null) steps.push({ key: 'fees', label: 'Set up fee structures', done: feeStructures > 0 });
  const done = steps.filter((s) => s.done).length;
  return { steps, done, total: steps.length, complete: done === steps.length, currentSession: session?.name || null };
}

module.exports = {
  currentSession, currentSessionName, sessionNameForDate, defaultSessionDates, createSession, setCurrentSession,
  defaultClassOrder, listClasses, hasClassMaster, assertClassSection, cleanSections, cleanSubjects, importClassesFromStudents,
  nextAdmissionNo, nextRollNumber, recordPlacement, closeEnrollment, movePlacement, setupStatus, classKey,
};
