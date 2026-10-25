const mongoose = require('mongoose');
const Homework = require('../models/Homework');
const HomeworkDone = require('../models/HomeworkDone');
const Student = require('../models/Student');
const { HttpError, asyncHandler, assertId } = require('../utils/http');
const { parseClassKey } = require('../utils/classes');
const { toDayKey, formatDay } = require('../utils/dates');
const { studentForUser, resolveChild } = require('../services/directory');
const { classScope, coversClass } = require('../services/scope');
const { scopeOf } = require('../services/authorization');
const { notifyStudent, notifyParents } = require('../services/notify');
const attachments = require('../services/attachments');

const clean = (v, max) => String(v ?? '').trim().slice(0, max);

// What the apps get for one homework. `done` is only added for a student (or a parent looking at their child).
function present(hw, extra = {}) {
  const o = hw.toObject ? hw.toObject() : hw;
  return {
    _id: o._id, title: o.title, description: o.description, subject: o.subject, class: o.class, section: o.section,
    audience: o.audience, studentCount: o.audience === 'students' ? (o.students || []).length : undefined,
    dueDate: formatDay(o.dueDate), createdAt: o.createdAt, teacherName: o.teacherName,
    attachments: (o.attachments || []).map(attachments.present).filter(Boolean),
    ...extra,
  };
}

// The students a homework is for.
async function audienceOf(hw) {
  const filter = { school: hw.school, isActive: true, class: hw.class };
  if (hw.section) filter.section = hw.section;
  if (hw.audience === 'students') filter._id = { $in: hw.students };
  return Student.find(filter).select('name rollNumber class section userId parentUserId school').sort({ section: 1, rollNumber: 1 });
}

// Does this homework reach this student?
const reaches = (hw, student) => hw.class === student.class && (!hw.section || hw.section === student.section)
  && (hw.audience === 'class' || (hw.students || []).some((id) => String(id) === String(student._id)));

// POST /api/homework (multipart; staff who may share study material, for their own classes)
const create = asyncHandler(async (req, res) => {
  const body = req.body || {};
  const title = clean(body.title, 200);
  const subject = clean(body.subject, 80);
  const key = parseClassKey(body.class, body.section);
  if (!title || !subject || !key.class) throw new HttpError(400, 'Title, subject and class are required');
  const due = toDayKey(body.dueDate);
  if (!due || !/^\d{4}-\d{2}-\d{2}$/.test(String(body.dueDate))) throw new HttpError(400, 'Choose a due date');
  if (due < toDayKey(new Date())) throw new HttpError(400, 'The due date cannot be in the past');
  if (!coversClass(await classScope(req.user, 'academic'), key.class, key.section)) throw new HttpError(403, 'You are not assigned to this class');

  const audience = body.audience === 'students' ? 'students' : 'class';
  let students = [];
  if (audience === 'students') {
    let ids = body.studentIds;
    if (typeof ids === 'string') { try { ids = JSON.parse(ids); } catch { ids = ids.split(','); } }
    ids = [...new Set((Array.isArray(ids) ? ids : []).map(String).filter((id) => mongoose.isValidObjectId(id)))];
    if (!ids.length) throw new HttpError(400, 'Choose at least one student');
    const filter = { _id: { $in: ids }, school: req.schoolId, isActive: true, class: key.class };
    if (key.section) filter.section = key.section;
    const found = await Student.find(filter).select('_id');
    if (found.length !== ids.length) throw new HttpError(400, 'Some of the chosen students are not in this class');
    students = found.map((s) => s._id);
  }

  const files = req.files || [];
  const stored = [];
  try {
    for (const f of files) stored.push(await attachments.save(f, req.schoolId, 'homework'));
    const hw = await Homework.create({
      school: req.schoolId, title, description: clean(body.description, 4000), subject, class: key.class, section: key.section || '',
      audience, students, dueDate: due, attachments: stored, createdBy: req.user._id, teacherName: req.user.name,
    });
    // Tell the students and their parents; best effort, in small groups so a big class does not open hundreds of writes at once.
    const targets = await audienceOf(hw);
    const note = { title: `New homework: ${subject}`, message: `${title}. Due ${formatDay(due)}.`, type: 'Homework', createdBy: req.user._id };
    (async () => {
      for (let i = 0; i < targets.length; i += 15) {
        await Promise.all(targets.slice(i, i + 15).map((s) => Promise.allSettled([notifyStudent(s, note), notifyParents(s, note)])));
      }
    })().catch(() => {});
    res.status(201).json({ success: true, data: present(hw, { assigned: targets.length, done: 0 }) });
  } catch (err) {
    await Promise.all(stored.map((a) => attachments.remove(a)));
    throw err;
  }
});

// GET /api/homework?class=&section= (staff: a teacher sees what they gave, the office sees all)
const listForStaff = asyncHandler(async (req, res) => {
  const reach = scopeOf(req.user, 'notes');
  if (reach === 'none') throw new HttpError(403, 'You do not have access to homework');
  const filter = { school: req.schoolId };
  if (reach === 'own') filter.createdBy = req.user._id;
  if (req.query.class) { const k = parseClassKey(req.query.class, req.query.section); filter.class = k.class; if (k.section) filter.section = k.section; }
  const list = await Homework.find(filter).sort({ dueDate: -1, createdAt: -1 }).limit(200);
  const counts = await HomeworkDone.aggregate([{ $match: { school: new mongoose.Types.ObjectId(String(req.schoolId)), homework: { $in: list.map((h) => h._id) } } }, { $group: { _id: '$homework', n: { $sum: 1 } } }]);
  const done = new Map(counts.map((c) => [String(c._id), c.n]));
  const sizes = new Map();
  for (const hw of list) {
    if (hw.audience === 'students') { sizes.set(String(hw._id), hw.students.length); continue; }
    const k = `${hw.class}|${hw.section}`;
    if (!sizes.has(k)) sizes.set(k, await Student.countDocuments({ school: req.schoolId, isActive: true, class: hw.class, ...(hw.section ? { section: hw.section } : {}) }));
  }
  res.json({ success: true, data: list.map((hw) => present(hw, { assigned: hw.audience === 'students' ? sizes.get(String(hw._id)) : sizes.get(`${hw.class}|${hw.section}`), done: done.get(String(hw._id)) || 0 })) });
});

// GET /api/homework/:id (staff): who it is for and who has marked it done
const detail = asyncHandler(async (req, res) => {
  assertId(req.params.id);
  const hw = await Homework.findOne({ _id: req.params.id, school: req.schoolId });
  if (!hw) throw new HttpError(404, 'Homework not found');
  if (scopeOf(req.user, 'notes') === 'own' && String(hw.createdBy) !== String(req.user._id)) throw new HttpError(404, 'Homework not found');
  const targets = await audienceOf(hw);
  const dones = await HomeworkDone.find({ school: req.schoolId, homework: hw._id }).select('student doneAt');
  const doneAt = new Map(dones.map((d) => [String(d.student), d.doneAt]));
  res.json({ success: true, data: present(hw, {
    assigned: targets.length, done: targets.filter((s) => doneAt.has(String(s._id))).length,
    students: targets.map((s) => ({ _id: s._id, name: s.name, rollNumber: s.rollNumber, section: s.section, done: doneAt.has(String(s._id)), doneAt: doneAt.get(String(s._id)) || null })),
  }) });
});

// DELETE /api/homework/:id (the teacher who gave it, or the office)
const remove = asyncHandler(async (req, res) => {
  assertId(req.params.id);
  const hw = await Homework.findOne({ _id: req.params.id, school: req.schoolId });
  if (!hw) throw new HttpError(404, 'Homework not found');
  if (scopeOf(req.user, 'notes') === 'own' && String(hw.createdBy) !== String(req.user._id)) throw new HttpError(403, 'You can only remove homework you gave');
  await Promise.all((hw.attachments || []).map((a) => attachments.remove(a)));
  await HomeworkDone.deleteMany({ school: req.schoolId, homework: hw._id });
  await Homework.deleteOne({ _id: hw._id, school: req.schoolId });
  res.json({ success: true });
});

async function forStudent(student, school) {
  const list = await Homework.find({
    school, class: student.class, section: { $in: [student.section, '', null] }, $or: [{ audience: 'class' }, { students: student._id }],
  }).sort({ dueDate: 1, createdAt: -1 }).limit(300);
  const done = await HomeworkDone.find({ school, student: student._id, homework: { $in: list.map((h) => h._id) } }).select('homework doneAt');
  const doneAt = new Map(done.map((d) => [String(d.homework), d.doneAt]));
  const today = toDayKey(new Date());
  return list.map((hw) => present(hw, { done: doneAt.has(String(hw._id)), doneAt: doneAt.get(String(hw._id)) || null, overdue: !doneAt.has(String(hw._id)) && hw.dueDate < today }));
}

// GET /api/homework/my (student)
const mine = asyncHandler(async (req, res) => {
  const student = await studentForUser(req.user);
  if (!student) throw new HttpError(404, 'Student not found');
  res.json({ success: true, data: await forStudent(student, req.schoolId) });
});

// GET /api/homework/child?studentId= (parent)
const ofChild = asyncHandler(async (req, res) => {
  const { child } = await resolveChild(req.user, req.query.studentId);
  if (!child) throw new HttpError(404, 'No student linked to this account');
  res.json({ success: true, data: await forStudent(child, req.schoolId), student: { _id: child._id, name: child.name } });
});

// POST /api/homework/:id/done and DELETE /api/homework/:id/done (student)
const setDone = (value) => asyncHandler(async (req, res) => {
  assertId(req.params.id);
  const student = await studentForUser(req.user);
  if (!student) throw new HttpError(404, 'Student not found');
  const hw = await Homework.findOne({ _id: req.params.id, school: req.schoolId });
  if (!hw || !reaches(hw, student)) throw new HttpError(404, 'Homework not found');
  if (value) await HomeworkDone.updateOne({ homework: hw._id, student: student._id, school: req.schoolId }, { $setOnInsert: { doneAt: new Date() } }, { upsert: true });
  else await HomeworkDone.deleteOne({ homework: hw._id, student: student._id, school: req.schoolId });
  res.json({ success: true, done: value });
});

module.exports = { create, listForStaff, detail, remove, mine, ofChild, markDone: setDone(true), markUndone: setDone(false) };
