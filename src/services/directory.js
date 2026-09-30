// Lookups that connect login accounts (User) with school records (Student, Teacher, Parent).
// Parent links historically live in two places (Student.parentUserId and Parent.children);
// these helpers read both so every feature sees the same family relationships.

const Student = require('../models/Student');
const Teacher = require('../models/Teacher');
const Parent = require('../models/Parent');
const { teacherCoversClass } = require('../utils/classes');

async function studentForUser(user) {
  return Student.findOne({ userId: user._id, school: user.school._id || user.school, isActive: true });
}

async function teacherForUser(user) {
  return Teacher.findOne({ userId: user._id, school: user.school._id || user.school, isActive: true });
}

// All active children linked to a parent account, within the parent's school.
async function childrenForParent(user) {
  const school = user.school._id || user.school;
  const parent = await Parent.findOne({ userId: user._id, school });
  const ids = new Set((parent?.children || []).map(String));
  const direct = await Student.find({ parentUserId: user._id, school, isActive: true }).select('_id');
  direct.forEach((s) => ids.add(String(s._id)));
  if (!ids.size) return [];
  return Student.find({ _id: { $in: [...ids] }, school, isActive: true }).sort({ name: 1 });
}

// Picks the child a parent is asking about (?studentId=...), defaulting to the first child.
async function resolveChild(user, requestedId) {
  const children = await childrenForParent(user);
  if (!children.length) return { child: null, children };
  if (requestedId) {
    const child = children.find((c) => String(c._id) === String(requestedId)) || null;
    return { child, children };
  }
  return { child: children[0], children };
}

// User ids of every parent account linked to a student.
async function parentUserIdsForStudent(student) {
  const ids = new Set();
  if (student.parentUserId) ids.add(String(student.parentUserId));
  const parents = await Parent.find({ children: student._id, school: student.school }).select('userId');
  parents.forEach((p) => p.userId && ids.add(String(p.userId)));
  return [...ids];
}

// Can this user read academic data about this student?
async function canAccessStudent(user, student) {
  if (!student) return false;
  const school = String(user.school._id || user.school);
  if (String(student.school) !== school) return false;
  // Academic records (attendance, results): admins see everyone, teachers only their assigned classes.
  if (user.role === 'admin') return true;
  if (user.role === 'teacher') return teacherCoversClass(await teacherForUser(user), student.class, student.section);
  if (user.role === 'student') return String(student.userId) === String(user._id);
  if (user.role === 'parent') return (await parentUserIdsForStudent(student)).includes(String(user._id));
  return false;
}

module.exports = {
  studentForUser,
  teacherForUser,
  childrenForParent,
  resolveChild,
  parentUserIdsForStudent,
  canAccessStudent,
};
