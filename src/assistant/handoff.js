// Hand-offs: EduAmigo Ask passes a question to the right person as a numbered ticket and notifies them.
//
// Who gets it (domains.js "owner"):
//   accounts                       -> accountants, else admins
//   class_teacher / exam_cell /
//   subject_teacher                -> the student's class teacher (class master, then timetable, then any teacher
//                                     assigned to the class), else admins
//   transport / librarian / office -> admins
// High-priority tickets (safety, complaints, payment disputes) always include the admins as well.

const AssistantTicket = require('../models/AssistantTicket');
const Counter = require('../models/Counter');
const User = require('../models/User');
const Teacher = require('../models/Teacher');
const SchoolClass = require('../models/SchoolClass');
const Timetable = require('../models/Timetable');
const { notifyUser } = require('../services/notify');
const { teacherCoversClass } = require('../utils/classes');
const { DOMAINS, OWNERS } = require('./domains');

async function usersWithRole(school, role) {
  return User.find({ school, role, isActive: true }).select('_id').lean();
}

async function classTeacherUserIds(school, student) {
  if (!student) return [];
  const master = await SchoolClass.findOne({ school, name: student.class }).lean();
  let teacherId = master?.sections?.find((s) => s.name === String(student.section).toUpperCase())?.classTeacher || null;
  if (!teacherId) {
    const tt = await Timetable.findOne({ school, class: student.class, section: student.section, classTeacher: { $ne: null } }).select('classTeacher').lean();
    teacherId = tt?.classTeacher || null;
  }
  if (teacherId) {
    const t = await Teacher.findOne({ _id: teacherId, school, isActive: true }).select('userId').lean();
    if (t?.userId) return [t.userId];
  }
  const teachers = await Teacher.find({ school, isActive: true, userId: { $ne: null } }).select('userId assignedClasses').lean();
  return teachers.filter((t) => teacherCoversClass(t, student.class, student.section)).map((t) => t.userId).slice(0, 2);
}

async function assigneesFor(school, team, student, priority) {
  let ids = [];
  if (team === 'accounts') ids = (await usersWithRole(school, 'accountant')).map((u) => u._id);
  else if (['class_teacher', 'exam_cell', 'subject_teacher'].includes(team)) ids = await classTeacherUserIds(school, student);
  const admins = (await usersWithRole(school, 'admin')).map((u) => u._id);
  if (!ids.length || priority === 'high') ids = [...ids, ...admins];
  return [...new Set(ids.map(String))];
}

const REASON_TITLES = {
  sensitive: 'Needs attention',
  complaint: 'Complaint',
  requested: 'Asked for a person',
  unclear: 'Could not understand',
  not_covered: 'Question for the school',
};

// Creates the ticket and notifies the assignees. Returns the ticket.
async function createTicket({ school, user, domain, question, reason, student = null }) {
  const team = DOMAINS[domain]?.owner || 'office';
  const priority = reason === 'sensitive' ? 'high' : 'normal';
  const assignees = await assigneesFor(school, team, student, priority);
  const seq = await Counter.next(school, 'assistantTicket');
  const ticket = await AssistantTicket.create({
    school, number: `T-${1000 + seq}`, raisedBy: user._id, raisedRole: user.role, student: student?._id || null,
    domain: domain || null, question: String(question).slice(0, 1000), reason, priority, team, assignees,
  });

  const who = student ? `${user.name} (${user.role}, about ${student.name} ${student.class}-${student.section})` : `${user.name} (${user.role})`;
  await Promise.all(assignees.map((id) => notifyUser(school, id, {
    title: `${priority === 'high' ? 'Urgent: ' : ''}EduAmigo Ask ticket ${ticket.number}`,
    message: `${REASON_TITLES[reason]}. ${who} wrote: "${ticket.question.slice(0, 300)}"`,
    type: 'General',
  }).catch(() => null)));
  return ticket;
}

const teamLabel = (team) => OWNERS[team] || 'School office';

module.exports = { createTicket, assigneesFor, teamLabel, REASON_TITLES };
