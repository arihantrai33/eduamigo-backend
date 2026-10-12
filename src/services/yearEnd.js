// End of the academic year: promote, detain, pass out (graduate) or let students leave, then start the
// next session. History is kept: each student's enrollment for the old session is closed with the outcome
// and a new one is opened for the next session.
//
//   preview(school, toSession)  -> every active student with a suggested decision
//   apply(school, { toSession, decisions, makeCurrent }) -> applies decisions (suggestions for the rest)
//
// Suggestions: the next class in the school's class order, same section when it exists there (else the
// first section); students of the last class pass out. Roll numbers are given again, alphabetically, in
// every class-section of the new session. Students already enrolled in the new session are skipped, so
// running it twice does not promote anyone twice.

const Student = require('../models/Student');
const StudentEnrollment = require('../models/StudentEnrollment');
const AcademicSession = require('../models/AcademicSession');
const User = require('../models/User');
const School = require('../models/School');
const Counter = require('../models/Counter');
const academic = require('./academic');
const { HttpError } = require('../utils/http');
const { normalizeClass, normalizeSection } = require('../utils/classes');

const ACTIONS = ['promote', 'detain', 'leave', 'graduate'];

// Deactivates a student who leaves or passes out, with their login. The parent's login stays active while
// another child of theirs is still in the school.
async function deactivateStudent(student, status, reason = '') {
  student.isActive = false;
  student.exit = {
    ...(student.exit?.toObject?.() || student.exit || {}),
    status, date: new Date(), reason: String(reason || '').slice(0, 300),
    lastClass: `${student.class}-${student.section}`,
  };
  await student.save();
  await academic.closeEnrollment(student, status === 'graduated' ? 'graduated' : 'left', String(reason || '').slice(0, 300));
  if (student.userId) await User.updateOne({ _id: student.userId, school: student.school }, { isActive: false });
  if (student.parentUserId) {
    const siblings = await Student.countDocuments({ parentUserId: student.parentUserId, isActive: true, school: student.school });
    if (!siblings) await User.updateOne({ _id: student.parentUserId, school: student.school }, { isActive: false });
  }
  return student;
}

// Class order from the class master, or from the classes students are in when there is none.
async function classPlan(schoolId) {
  const master = await academic.listClasses(schoolId);
  if (master.length) return master.map((c) => ({ name: c.name, sections: c.sections.map((s) => s.name) }));
  const names = await Student.distinct('class', { school: schoolId, isActive: true });
  return names
    .map((name) => ({ name, order: academic.defaultClassOrder(name) }))
    .sort((a, b) => (a.order - b.order) || String(a.name).localeCompare(String(b.name), 'en', { numeric: true }))
    .map(({ name }) => ({ name, sections: null }));
}

function suggest(student, plan) {
  const i = plan.findIndex((c) => c.name === student.class);
  if (i === -1) return { action: 'detain', toClass: student.class, toSection: student.section, note: 'Class is not in the class list' };
  const next = plan[i + 1];
  if (!next) return { action: 'graduate' };
  const section = !next.sections || next.sections.includes(student.section) ? student.section : next.sections[0];
  if (!section) return { action: 'detain', toClass: student.class, toSection: student.section, note: `Class ${next.name} has no sections yet` };
  return { action: 'promote', toClass: next.name, toSection: section };
}

async function loadSession(schoolId, name) {
  const session = await AcademicSession.findOne({ school: schoolId, name: String(name || '') });
  if (!session) throw new HttpError(400, `Session ${name || '(none)'} does not exist. Create it under School Setup first.`);
  return session;
}

async function preview(schoolId, toSession) {
  await loadSession(schoolId, toSession);
  const plan = await classPlan(schoolId);
  const students = await Student.find({ school: schoolId, isActive: true }).select('name admissionNo class section rollNumber').sort({ class: 1, section: 1, name: 1 }).lean();
  const done = new Set((await StudentEnrollment.find({ school: schoolId, session: toSession }).select('student').lean()).map((e) => String(e.student)));
  const rows = students.map((s) => ({
    student: { _id: s._id, name: s.name, admissionNo: s.admissionNo, class: s.class, section: s.section, rollNumber: s.rollNumber },
    alreadyInSession: done.has(String(s._id)),
    suggestion: suggest(s, plan),
  }));
  const counts = rows.reduce((acc, r) => {
    const k = r.alreadyInSession ? 'alreadyDone' : r.suggestion.action;
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});
  return { toSession, classes: plan.map((c) => c.name), counts, students: rows };
}

async function apply(schoolId, { toSession, decisions = [], makeCurrent = false } = {}) {
  const session = await loadSession(schoolId, toSession);
  if (!Array.isArray(decisions)) throw new HttpError(400, 'decisions must be a list');
  const plan = await classPlan(schoolId);
  const byId = new Map();
  for (const d of decisions) {
    if (!d || !ACTIONS.includes(d.action)) throw new HttpError(400, `Each decision needs an action: ${ACTIONS.join(', ')}`);
    byId.set(String(d.studentId), d);
  }

  const students = await Student.find({ school: schoolId, isActive: true });
  const done = new Set((await StudentEnrollment.find({ school: schoolId, session: toSession }).select('student').lean()).map((e) => String(e.student)));
  const known = new Set(students.map((s) => String(s._id)));
  const unknown = [...byId.keys()].filter((id) => !known.has(id));
  if (unknown.length) throw new HttpError(400, `${unknown.length} decision(s) are for students who are not active in this school`);

  // Work out every move first and validate it, so a bad decision changes nothing.
  const plans = [];
  for (const student of students) {
    if (done.has(String(student._id))) continue;
    const d = byId.get(String(student._id)) || suggest(student, plan);
    if (d.action === 'promote' || d.action === 'detain') {
      const toClass = normalizeClass(d.action === 'detain' ? (d.toClass || student.class) : d.toClass);
      const toSection = normalizeSection(d.action === 'detain' ? (d.toSection || student.section) : d.toSection);
      if (!toClass || !toSection) throw new HttpError(400, `Choose the class and section for ${student.name}`);
      await academic.assertClassSection(schoolId, toClass, toSection);
      plans.push({ student, action: d.action, toClass, toSection });
    } else {
      plans.push({ student, action: d.action, reason: d.reason || (d.action === 'graduate' ? 'Passed out' : '') });
    }
  }

  const summary = { promote: 0, detain: 0, leave: 0, graduate: 0, skipped: done.size };
  const moving = plans.filter((p) => p.action === 'promote' || p.action === 'detain');

  // Roll numbers are unique per class-section: park everyone who stays on a temporary number first.
  for (const p of moving) await Student.updateOne({ _id: p.student._id, school: schoolId }, { rollNumber: `~${p.student._id}` });

  for (const p of plans) {
    summary[p.action] += 1;
    if (p.action === 'leave' || p.action === 'graduate') {
      await deactivateStudent(p.student, p.action === 'graduate' ? 'graduated' : 'left', p.reason);
      continue;
    }
    await StudentEnrollment.updateMany(
      { school: schoolId, student: p.student._id, status: 'studying', session: { $ne: toSession } },
      { $set: { status: p.action === 'promote' ? 'promoted' : 'detained', endedAt: new Date() } },
    );
    await Student.updateOne({ _id: p.student._id, school: schoolId }, { class: p.toClass, section: p.toSection });
  }

  // New roll numbers, alphabetical, in every class-section that received students.
  const groups = [...new Set(moving.map((p) => `${p.toClass}|${p.toSection}`))];
  for (const key of groups) {
    const [cls, section] = key.split('|');
    const group = await Student.find({ school: schoolId, isActive: true, class: cls, section }).sort({ name: 1, _id: 1 });
    // Students who were not part of this run keep their place after the newcomers are parked.
    for (const s of group) await Student.updateOne({ _id: s._id, school: schoolId }, { rollNumber: `~${s._id}` });
    for (const [i, s] of group.entries()) {
      s.rollNumber = String(i + 1);
      await Student.updateOne({ _id: s._id, school: schoolId }, { rollNumber: s.rollNumber });
      await academic.recordPlacement(s, { session: toSession });
    }
  }

  if (makeCurrent) await academic.setCurrentSession(schoolId, session._id);
  return summary;
}

// Transfer certificate data for a student who has left or passed out. The number is given once.
async function transferCertificate(schoolId, studentId) {
  const student = await Student.findOne({ _id: studentId, school: schoolId });
  if (!student) throw new HttpError(404, 'Student not found');
  if (student.isActive || !student.exit?.status) throw new HttpError(409, 'A transfer certificate is issued when the student leaves or passes out');
  if (!student.exit.tcNumber) {
    const year = new Date().getUTCFullYear();
    const seq = await Counter.next(schoolId, `tc:${year}`);
    student.exit.tcNumber = `TC/${year}/${String(seq).padStart(4, '0')}`;
    student.exit.tcIssuedAt = new Date();
    await student.save();
  }
  const [school, history] = await Promise.all([
    School.findById(schoolId).select('name address city phone email principal branding.logoUrl').lean(),
    StudentEnrollment.find({ school: schoolId, student: student._id }).sort({ session: 1 }).lean(),
  ]);
  return {
    tcNumber: student.exit.tcNumber,
    issuedAt: student.exit.tcIssuedAt,
    school,
    student: {
      name: student.name, admissionNo: student.admissionNo, dateOfBirth: student.dateOfBirth || null,
      gender: student.gender || '', parentName: student.parentName || '', address: student.address || '',
      admittedOn: student.createdAt, lastClass: student.exit.lastClass, leftOn: student.exit.date,
      reason: student.exit.reason || (student.exit.status === 'graduated' ? 'Passed out' : ''),
      status: student.exit.status,
    },
    history: history.map((h) => ({ session: h.session, class: `${h.class}-${h.section}`, result: h.status })),
  };
}

module.exports = { preview, apply, deactivateStudent, transferCertificate, suggest, ACTIONS };
