// Hand-off recipients: who a ticket goes to. (Creating, updating and notifying is done by the ticket actions, actions/ticketActions.js.)
//
// Who gets it (domains.js "owner"):
//   accounts                       -> accountants, else admins
//   class_teacher / exam_cell /
//   subject_teacher                -> the student's class teacher (class master, then timetable, then any teacher
//                                     assigned to the class), else admins
//   transport / librarian / office -> admins
// High-priority tickets (safety, complaints, payment disputes) always include the admins as well.

const User = require('../models/User');
const Teacher = require('../models/Teacher');
const SchoolClass = require('../models/SchoolClass');
const Timetable = require('../models/Timetable');
const { teacherCoversClass } = require('../utils/classes');
const { DOMAINS, OWNERS } = require('./domains');

async function usersWithRole(school, role) {
  return User.find({ school, role, isActive: true }).select('_id name').lean();
}

const titleCase = (s) => String(s || '').trim().replace(/\b\w/g, (c) => c.toUpperCase());
const person = (userId, name, title) => ({ userId: userId ? String(userId) : null, name, title });

// The teacher who takes `subject` for the student's class (most periods a week), from the timetable.
async function subjectTeacher(school, student, subject) {
  if (!student || !subject) return null;
  const rows = await Timetable.find({ school, class: student.class, section: student.section }).select('periods').lean();
  const wanted = String(subject).toLowerCase().replace(/[^a-z]/g, '');
  const counts = new Map();
  for (const row of rows) {
    for (const p of row.periods || []) {
      const sub = String(p.subject || '').toLowerCase().replace(/[^a-z]/g, '');
      if (p.teacher && sub && (sub.includes(wanted) || wanted.includes(sub) || (sub.length >= 4 && wanted.length >= 4 && sub.slice(0, 4) === wanted.slice(0, 4)))) counts.set(String(p.teacher), (counts.get(String(p.teacher)) || 0) + 1);
    }
  }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (!best) return null;
  const t = await Teacher.findOne({ _id: best[0], school, isActive: true }).select('name userId subjects').lean();
  return t ? person(t.userId, t.name, `${titleCase(subject)} teacher`) : null;
}

// A teacher the person named ("Sunita madam"): matched on any word of the name.
async function namedTeacher(school, name) {
  const words = String(name || '').toLowerCase().split(/\s+/).filter((w) => w.length >= 3 && !['sir', 'madam', 'maam', 'miss', 'mam'].includes(w));
  if (!words.length) return null;
  const found = await Teacher.find({ school, isActive: true, name: { $regex: `(^|\\s)(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, $options: 'i' } }).select('name userId').limit(2).lean();
  return found.length === 1 ? person(found[0].userId, found[0].name, 'Teacher') : null;
}

async function classTeacher(school, student) {
  if (!student) return null;
  const master = await SchoolClass.findOne({ school, name: student.class }).lean();
  let teacherId = master?.sections?.find((s) => s.name === String(student.section).toUpperCase())?.classTeacher || null;
  if (!teacherId) {
    const tt = await Timetable.findOne({ school, class: student.class, section: student.section, classTeacher: { $ne: null } }).select('classTeacher').lean();
    teacherId = tt?.classTeacher || null;
  }
  const title = `Class teacher, ${student.class}-${student.section}`;
  if (teacherId) {
    const t = await Teacher.findOne({ _id: teacherId, school, isActive: true }).select('name userId').lean();
    if (t) return person(t.userId, t.name, title);
  }
  const teachers = await Teacher.find({ school, isActive: true, userId: { $ne: null } }).select('name userId assignedClasses').lean();
  const t = teachers.find((x) => teacherCoversClass(x, student.class, student.section));
  return t ? person(t.userId, t.name, title) : null;
}

// Who a question goes to, by name: { team, people: [{ userId, name, title }] }.
//   a teacher the person named, else the subject's teacher for the student's class, else the topic's owner
//   (accounts -> accountants, class / exam topics -> class teacher, others -> admins).
// Urgent tickets always include the admins too. Nobody found -> the school admins.
async function recipientsFor({ school, domain, student = null, subject = null, personName = null, priority = 'normal' }) {
  let team = DOMAINS[domain]?.owner || 'office';
  let people = [];
  const named = await namedTeacher(school, personName);
  if (named) { people = [named]; team = 'subject_teacher'; }
  else {
    const sub = await subjectTeacher(school, student, subject);
    if (sub) { people = [sub]; team = 'subject_teacher'; }
    else if (team === 'accounts') people = (await usersWithRole(school, 'accountant')).map((u) => person(u._id, u.name, 'Accounts office'));
    else if (['class_teacher', 'exam_cell', 'subject_teacher'].includes(team)) {
      const ct = await classTeacher(school, student);
      if (ct) people = [ct];
    }
  }
  const admins = (await usersWithRole(school, 'admin')).map((u) => person(u._id, u.name, 'School office'));
  const reachable = people.filter((p) => p.userId);
  if (!reachable.length || priority === 'high') people = [...people, ...admins];
  return { team, people };
}

const teamLabel = (team) => OWNERS[team] || 'School office';

module.exports = { recipientsFor, teamLabel };
