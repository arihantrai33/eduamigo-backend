const Notification = require('../models/Notification');
const { parentUserIdsForStudent } = require('./directory');

// Personal notification for one user.
async function notifyUser(school, recipient, { title, message, type = 'Info', createdBy = null }) {
  if (!recipient) return null;
  return Notification.create({ school, recipient, title, message, type, createdBy, targetRole: 'all' });
}

// Personal notification to every parent linked to a student.
async function notifyParents(student, payload) {
  const parentIds = await parentUserIdsForStudent(student);
  await Promise.all(parentIds.map((id) => notifyUser(student.school, id, payload)));
  return parentIds.length;
}

async function notifyStudent(student, payload) {
  if (!student.userId) return 0;
  await notifyUser(student.school, student.userId, payload);
  return 1;
}

// Broadcast to a role (or 'all') inside one school.
async function broadcast(school, { title, message, type = 'General', targetRole = 'all', createdBy = null }) {
  return Notification.create({ school, recipient: null, title, message, type, targetRole, createdBy });
}

module.exports = { notifyUser, notifyParents, notifyStudent, broadcast };
