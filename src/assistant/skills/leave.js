// Leave requests skill (student leave, LeaveRequest). Staff leave is the HR skill.
//   students and parents: status of their latest requests; "I need leave" points to the Apply Leave screen
//   teachers: pending requests from their classes;  admins: pending requests in the school
// The assistant never applies for or approves leave itself: those are actions on their own screens.

const LeaveRequest = require('../../models/LeaveRequest');
const { hasPhrase } = require('../text');
const { teacherCoversClass } = require('../../utils/classes');
const { day, plural, link, source } = require('./util');

const APPLY_WORDS = ['apply', 'chahiye', 'chahie', 'leni', 'lena', 'need leave', 'want leave', 'kaise', 'how to', 'how do'];

const line = (r) => `${r.leaveType} leave ${day(r.fromDate, { short: true })}${day(r.toDate) !== day(r.fromDate) ? ` to ${day(r.toDate, { short: true })}` : ''} (${plural(r.days || 1, 'day')}): ${r.status}${r.reviewNote ? `, note: "${r.reviewNote}"` : ''}`;

async function mine(ctx) {
  const ids = (ctx.students || []).map((s) => s._id);
  const rows = await LeaveRequest.find({ school: ctx.schoolId, $or: [{ requestedBy: ctx.user._id }, ...(ids.length ? [{ studentId: { $in: ids } }] : [])] })
    .sort({ createdAt: -1 }).limit(3).lean();
  const applyLink = link('leave', ctx.role);
  if (hasPhrase(ctx.text, APPLY_WORDS)) {
    return {
      text: `You can apply for leave on the Apply Leave screen: choose the dates and reason, and the class teacher will review it.${rows[0] ? `\nYour latest request: ${line(rows[0])}.` : ''}`,
      facts: { latest: rows[0] ? { type: rows[0].leaveType, from: day(rows[0].fromDate), to: day(rows[0].toDate), status: rows[0].status } : null },
      sources: rows[0] ? [source('leave', 'Leave request', rows[0]._id, rows[0])] : [],
      link: applyLink,
    };
  }
  if (!rows.length) return { text: 'There are no leave requests on your account.', facts: { requests: 0 }, sources: [], link: applyLink };
  return {
    text: `Your leave requests:\n${rows.map((r) => `- ${r.name && ctx.role === 'parent' ? `${r.name}: ` : ''}${line(r)}`).join('\n')}`,
    facts: { requests: rows.map((r) => ({ for: r.name, type: r.leaveType, from: day(r.fromDate), to: day(r.toDate), days: r.days, status: r.status })) },
    sources: rows.map((r) => source('leave', `Leave request · ${day(r.fromDate, { short: true })}`, r._id, r)),
    link: applyLink,
  };
}

async function toReview(ctx) {
  let rows = await LeaveRequest.find({ school: ctx.schoolId, status: 'Pending', role: { $in: ['student', 'parent'] } }).sort({ fromDate: 1 }).lean();
  if (ctx.role === 'teacher') rows = rows.filter((r) => teacherCoversClass(ctx.teacher, r.class, r.section));
  const scope = ctx.role === 'teacher' ? 'from your classes' : 'in the school';
  if (!rows.length) return { text: `No student leave requests are waiting for review ${scope}.`, facts: { pending: 0 }, sources: [], link: link('leave', ctx.role) };
  return {
    text: `${plural(rows.length, 'leave request')} waiting for review ${scope}:\n${rows.slice(0, 8).map((r) => `- ${r.name || 'Student'}${r.class ? ` (${r.class}-${r.section})` : ''}: ${r.leaveType}, ${day(r.fromDate, { short: true })}${day(r.toDate) !== day(r.fromDate) ? ` to ${day(r.toDate, { short: true })}` : ''}`).join('\n')}`,
    facts: { pending: rows.length, items: rows.slice(0, 8).map((r) => ({ name: r.name, class: r.class ? `${r.class}-${r.section}` : null, from: day(r.fromDate), to: day(r.toDate) })) },
    sources: [source('leave', 'Leave requests · pending')],
    link: link('leave', ctx.role),
  };
}

async function run(ctx) {
  if (ctx.role === 'student' || ctx.role === 'parent') return mine(ctx);
  if (ctx.role === 'teacher' || ctx.role === 'admin') return toReview(ctx);
  return { blocked: true, text: 'Leave requests are not available for your account.' };
}

module.exports = { run, needsStudent: false };
