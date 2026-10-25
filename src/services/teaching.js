// Teaching assignments: which subject a teacher teaches in which class-section.
//
// A teacher who has assignments is limited to exactly those (class, section, subject) combinations. A teacher with none keeps the
// older rule from the teacher's own lists (assigned classes, and subjects, where an empty list means any subject), so nothing changes
// until a school sets assignments up (or the migration creates them from the lists).
const TeachingAssignment = require('../models/TeachingAssignment');
const { HttpError } = require('../utils/http');
const { normalizeClass, normalizeSection, parseClassKey, teacherCoversClass } = require('../utils/classes');

const sameText = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

const assignmentsOf = (school, teacherId) => TeachingAssignment.find({ school, teacher: teacherId }).sort({ class: 1, section: 1, subject: 1 }).lean();

// Whether the teacher may act on a subject in a class-section. `assignments` comes from assignmentsOf (load once per request).
function teachesSubject(teacher, assignments, cls, section, subject) {
  if (!teacher) return false;
  if (assignments && assignments.length) {
    const c = normalizeClass(cls);
    const s = normalizeSection(section);
    return assignments.some((a) => a.class === c && (!a.section || !s || a.section === s) && sameText(a.subject, subject));
  }
  if (!teacherCoversClass(teacher, cls, section)) return false;
  const subjects = teacher.subjects || [];
  return !subjects.length || subjects.some((x) => sameText(x, subject));
}

// Replaces a teacher's whole set of assignments. Classes that are assigned also become classes the teacher covers (attendance,
// student lists), because teaching a class needs to see it. Nothing is removed from the class list here.
async function replaceAssignments(school, teacher, rows) {
  if (!Array.isArray(rows)) throw new HttpError(400, 'assignments must be a list');
  if (rows.length > 200) throw new HttpError(400, 'Too many assignments');
  const clean = new Map();
  for (const r of rows) {
    const key = parseClassKey(r?.class, r?.section);
    const subject = typeof r?.subject === 'string' ? r.subject.trim().slice(0, 60) : '';
    if (!key.class) throw new HttpError(400, 'Each assignment needs a class');
    if (!subject) throw new HttpError(400, 'Each assignment needs a subject');
    clean.set(`${key.class}|${key.section || ''}|${subject.toLowerCase()}`, { school, teacher: teacher._id, class: key.class, section: key.section || '', subject, isClassTeacher: !!r.isClassTeacher });
  }
  await TeachingAssignment.deleteMany({ school, teacher: teacher._id });
  const docs = clean.size ? await TeachingAssignment.insertMany([...clean.values()]) : [];
  const covered = new Set(teacher.assignedClasses || []);
  for (const d of docs) {
    const entry = d.section ? `${d.class}-${d.section}` : d.class;
    const already = [...covered].some((e) => teacherCoversClass({ assignedClasses: [e] }, d.class, d.section));
    if (!already) covered.add(entry);
  }
  if (covered.size !== (teacher.assignedClasses || []).length) {
    teacher.assignedClasses = [...covered];
    await teacher.save();
  }
  return docs;
}

module.exports = { assignmentsOf, teachesSubject, replaceAssignments };
