// School setup: academic sessions, classes/sections/subjects/class teachers, academic settings and
// the setup checklist used by the onboarding wizard.
const mongoose = require('mongoose');
const SchoolClass = require('../models/SchoolClass');
const AcademicSession = require('../models/AcademicSession');
const Student = require('../models/Student');
const Teacher = require('../models/Teacher');
const School = require('../models/School');
const { HttpError, asyncHandler, assertId, isValidId } = require('../utils/http');
const { normalizeClass, classKey } = require('../utils/classes');
const academic = require('../services/academic');

// ---------------- Sessions ----------------

// GET /api/academic/sessions
exports.listSessions = asyncHandler(async (req, res) => {
  const sessions = await AcademicSession.find({ school: req.schoolId }).sort({ startDate: -1 });
  res.json({ success: true, data: sessions, current: await academic.currentSessionName(req.schoolId) });
});

// POST /api/academic/sessions { name: "2026-27", startDate?, endDate?, makeCurrent? }
exports.createSession = asyncHandler(async (req, res) => {
  const session = await academic.createSession(req.schoolId, req.body || {});
  res.status(201).json({ success: true, data: session });
});

// PATCH /api/academic/sessions/:id/current
exports.makeCurrent = asyncHandler(async (req, res) => {
  assertId(req.params.id);
  const session = await academic.setCurrentSession(req.schoolId, req.params.id);
  res.json({ success: true, data: session });
});

// ---------------- Classes ----------------

// GET /api/academic/classes — classes in order, with sections, class teachers and student counts
exports.listClasses = asyncHandler(async (req, res) => {
  const classes = await academic.listClasses(req.schoolId, { includeInactive: req.query.all === 'true' });
  const counts = await Student.aggregate([
    { $match: { school: req.schoolId, isActive: true } },
    { $group: { _id: { class: '$class', section: '$section' }, n: { $sum: 1 } } },
  ]);
  const countOf = new Map(counts.map((c) => [`${c._id.class}|${c._id.section}`, c.n]));
  const teacherIds = classes.flatMap((c) => c.sections.map((s) => s.classTeacher)).filter(Boolean);
  const teachers = await Teacher.find({ _id: { $in: teacherIds }, school: req.schoolId }).select('name').lean();
  const teacherName = new Map(teachers.map((t) => [String(t._id), t.name]));

  const data = classes.map((c) => ({
    ...c,
    displayName: c.displayName || `Class ${c.name}`,
    sections: c.sections.map((s) => ({
      ...s,
      classTeacherName: s.classTeacher ? teacherName.get(String(s.classTeacher)) || null : null,
      students: countOf.get(`${c.name}|${s.name}`) || 0,
    })),
    students: c.sections.reduce((n, s) => n + (countOf.get(`${c.name}|${s.name}`) || 0), 0),
  }));
  res.json({ success: true, data });
});

// Class teachers must be teachers of this school; they also get the class in their assigned classes.
async function checkClassTeachers(req, className, sections) {
  for (const s of sections) {
    if (!s.classTeacher) continue;
    if (!isValidId(s.classTeacher)) throw new HttpError(400, 'Invalid class teacher');
    const ok = await Teacher.exists({ _id: s.classTeacher, school: req.schoolId, isActive: { $ne: false } });
    if (!ok) throw new HttpError(400, `Class teacher for section ${s.name} is not a teacher of this school`);
  }
}

async function giveClassTeachersAccess(req, className, sections) {
  for (const s of sections) {
    if (s.classTeacher) {
      await Teacher.updateOne({ _id: s.classTeacher, school: req.schoolId }, { $addToSet: { assignedClasses: classKey(className, s.name) } });
    }
  }
}

// POST /api/academic/classes { name, displayName?, order?, sections: ["A","B"] | [{name, classTeacher, capacity}], subjects: [] }
exports.createClass = asyncHandler(async (req, res) => {
  const body = req.body || {};
  const name = normalizeClass(body.name);
  if (!name) throw new HttpError(400, 'Class name is required');
  if (await SchoolClass.exists({ school: req.schoolId, name })) throw new HttpError(409, `Class ${name} already exists`);
  const sections = academic.cleanSections(body.sections) || [];
  await checkClassTeachers(req, name, sections);
  const created = await SchoolClass.create({
    school: req.schoolId, name,
    displayName: String(body.displayName || `Class ${name}`).trim(),
    order: body.order !== undefined ? Number(body.order) || 0 : academic.defaultClassOrder(name),
    sections, subjects: academic.cleanSubjects(body.subjects) || [],
  });
  await giveClassTeachersAccess(req, name, sections);
  res.status(201).json({ success: true, data: created });
});

// PUT /api/academic/classes/:id { displayName, order, sections, subjects, isActive }
// Sections that still have active students cannot be removed. The class name cannot change once students are in it.
exports.updateClass = asyncHandler(async (req, res) => {
  assertId(req.params.id);
  const cls = await SchoolClass.findOne({ _id: req.params.id, school: req.schoolId });
  if (!cls) throw new HttpError(404, 'Class not found');
  const body = req.body || {};

  if (body.name !== undefined && normalizeClass(body.name) !== cls.name) {
    if (await Student.exists({ school: req.schoolId, class: cls.name, isActive: true })) {
      throw new HttpError(409, 'This class has students, so its name cannot be changed. Create a new class and promote the students instead.');
    }
    const name = normalizeClass(body.name);
    if (await SchoolClass.exists({ school: req.schoolId, name })) throw new HttpError(409, `Class ${name} already exists`);
    cls.name = name;
  }
  const sections = academic.cleanSections(body.sections);
  if (sections) {
    const removed = cls.sections.filter((s) => !sections.some((n) => n.name === s.name)).map((s) => s.name);
    if (removed.length) {
      const inUse = await Student.countDocuments({ school: req.schoolId, class: cls.name, section: { $in: removed }, isActive: true });
      if (inUse) throw new HttpError(409, `Section ${removed.join(', ')} still has ${inUse} student(s). Move them first.`);
    }
    await checkClassTeachers(req, cls.name, sections);
    cls.sections = sections;
  }
  const subjects = academic.cleanSubjects(body.subjects);
  if (subjects) cls.subjects = subjects;
  if (body.displayName !== undefined) cls.displayName = String(body.displayName).trim();
  if (body.order !== undefined) cls.order = Number(body.order) || 0;
  if (body.isActive !== undefined) {
    if (!body.isActive && await Student.exists({ school: req.schoolId, class: cls.name, isActive: true })) {
      throw new HttpError(409, 'This class still has students. Move them before deactivating the class.');
    }
    cls.isActive = !!body.isActive;
  }
  await cls.save();
  await giveClassTeachersAccess(req, cls.name, cls.sections);
  res.json({ success: true, data: cls });
});

// DELETE /api/academic/classes/:id — only when no student (active or past) is in it
exports.deleteClass = asyncHandler(async (req, res) => {
  assertId(req.params.id);
  const cls = await SchoolClass.findOne({ _id: req.params.id, school: req.schoolId });
  if (!cls) throw new HttpError(404, 'Class not found');
  if (await Student.exists({ school: req.schoolId, class: cls.name })) {
    throw new HttpError(409, 'Students have been in this class, so it cannot be deleted. Deactivate it instead.');
  }
  await SchoolClass.deleteOne({ _id: cls._id, school: req.schoolId });
  res.json({ success: true, message: `Class ${cls.name} deleted` });
});

// POST /api/academic/classes/import — builds the class list from existing students' classes and sections
exports.importClasses = asyncHandler(async (req, res) => {
  const result = await academic.importClassesFromStudents(new mongoose.Types.ObjectId(String(req.schoolId)));
  res.json({ success: true, data: result, message: `${result.created} class(es) added, ${result.updated} updated` });
});

// ---------------- Settings and setup ----------------

// GET /api/academic/settings
exports.getSettings = asyncHandler(async (req, res) => {
  const school = await School.findById(req.schoolId).select('academic').lean();
  res.json({
    success: true,
    data: {
      sessionStartMonth: school?.academic?.sessionStartMonth || 4,
      admissionNoPrefix: school?.academic?.admissionNoPrefix || '',
      currentSession: await academic.currentSessionName(req.schoolId),
    },
  });
});

// PUT /api/academic/settings { sessionStartMonth, admissionNoPrefix }
exports.saveSettings = asyncHandler(async (req, res) => {
  const body = req.body || {};
  const update = {};
  if (body.sessionStartMonth !== undefined) {
    const m = Number(body.sessionStartMonth);
    if (!Number.isInteger(m) || m < 1 || m > 12) throw new HttpError(400, 'Session start month must be 1 to 12');
    update['academic.sessionStartMonth'] = m;
  }
  if (body.admissionNoPrefix !== undefined) {
    const prefix = String(body.admissionNoPrefix).trim();
    if (!/^[A-Za-z0-9/-]{0,12}$/.test(prefix)) throw new HttpError(400, 'Prefix can have up to 12 letters, digits, / or -');
    update['academic.admissionNoPrefix'] = prefix;
  }
  await School.updateOne({ _id: req.schoolId }, { $set: update }, { runValidators: true });
  return exports.getSettings(req, res);
});

// GET /api/academic/setup-status — checklist for the school onboarding wizard
exports.setupStatus = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await academic.setupStatus(req.schoolId, req.entitlements?.features || []) });
});

// ---------------- End of year ----------------
const yearEnd = require('../services/yearEnd');

// GET /api/academic/year-end?toSession=2027-28 — every active student with a suggested decision
exports.yearEndPreview = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await yearEnd.preview(req.schoolId, req.query.toSession) });
});

// POST /api/academic/year-end { toSession, decisions: [{ studentId, action, toClass?, toSection?, reason? }], makeCurrent? }
// Students without a decision get the suggestion.
exports.yearEndApply = asyncHandler(async (req, res) => {
  const { toSession, decisions, makeCurrent } = req.body || {};
  const summary = await yearEnd.apply(req.schoolId, { toSession, decisions, makeCurrent: !!makeCurrent });
  res.json({ success: true, data: summary, message: `${summary.promote} promoted, ${summary.detain} detained, ${summary.graduate} passed out, ${summary.leave} left` });
});

