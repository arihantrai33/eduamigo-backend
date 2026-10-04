// HR & payroll skill: StaffLeave and Salary.
//   teachers: their own leave taken this session, pending requests and latest salary slip
//   admins: one teacher by name ("Ramesh sir ki leave"), or pending staff leave and this month's payroll
// The school does not store a leave allowance, so the assistant reports leave taken and pending,
// never an invented "balance".

const StaffLeave = require('../../models/StaffLeave');
const Salary = require('../../models/Salary');
const Teacher = require('../../models/Teacher');
const { hasPhrase } = require('../text');
const { personHint } = require('../entities');
const { money, day, today, plural, link, source, sessionStart, MONTHS, escapeRegex } = require('./util');

const SALARY_WORDS = ['salary', 'salaries', 'payslip', 'pay slip', 'salary slip', 'vetan', 'tankhwah', 'payroll', 'paid'];
const LEAVE_WORDS = ['leave', 'leaves', 'chhutti', 'chutti', 'casual', 'earned', 'sick'];

async function leaveSummary(ctx, teacher) {
  const from = sessionStart(ctx.now);
  const rows = await StaffLeave.find({ school: ctx.schoolId, teacher: teacher._id, fromDate: { $gte: from } }).sort({ fromDate: -1 }).lean();
  const approved = rows.filter((r) => r.status === 'Approved');
  const byType = {};
  approved.forEach((r) => { byType[r.leaveType] = (byType[r.leaveType] || 0) + (r.days || 1); });
  const taken = approved.reduce((s, r) => s + (r.days || 1), 0);
  const pending = rows.filter((r) => r.status === 'Pending');
  return {
    text: `Leave this session: ${plural(taken, 'day')} taken${Object.keys(byType).length ? ` (${Object.entries(byType).map(([t, d]) => `${t} ${d}`).join(', ')})` : ''}${pending.length ? `; ${plural(pending.length, 'request')} pending` : ''}.`,
    facts: { taken, byType, pending: pending.length },
    sources: rows.length ? [source('staff_leave', 'Staff leave records', rows[0]._id)] : [source('staff_leave', 'Staff leave records')],
  };
}

async function salarySummary(ctx, teacher) {
  const s = await Salary.findOne({ school: ctx.schoolId, teacher: teacher._id }).sort({ year: -1, month: -1 }).lean();
  if (!s) return { text: 'No salary slip has been generated yet.', facts: { salary: null }, sources: [] };
  return {
    text: `Salary for ${MONTHS[s.month - 1]} ${s.year}: net ${money(s.netSalary)} (basic ${money(s.basicSalary)}${s.allowances ? `, allowances ${money(s.allowances)}` : ''}${s.deductions ? `, deductions ${money(s.deductions)}` : ''}), ${s.status === 'Paid' ? `paid${s.paidOn ? ` on ${day(s.paidOn)}` : ''}` : 'not paid yet'}.`,
    facts: { month: `${MONTHS[s.month - 1]} ${s.year}`, net: s.netSalary, basic: s.basicSalary, allowances: s.allowances, deductions: s.deductions, status: s.status },
    sources: [source('salary', `Salary slip · ${MONTHS[s.month - 1]} ${s.year}`, s._id)],
  };
}

async function about(ctx, teacher, prefix = '') {
  const wantSalary = hasPhrase(ctx.text, SALARY_WORDS);
  const wantLeave = hasPhrase(ctx.text, LEAVE_WORDS);
  const parts = [];
  if (wantLeave || !wantSalary) parts.push(await leaveSummary(ctx, teacher));
  if (wantSalary || !wantLeave) parts.push(await salarySummary(ctx, teacher));
  return {
    text: `${prefix}${parts.map((p) => p.text).join('\n')}`,
    facts: Object.assign({ person: teacher.name }, ...parts.map((p) => p.facts)),
    sources: parts.flatMap((p) => p.sources),
  };
}

async function forAdmin(ctx) {
  const hint = personHint(ctx.text);
  if (hint) {
    const matches = await Teacher.find({ school: ctx.schoolId, isActive: true, name: { $regex: `(^|\\s)${escapeRegex(hint)}`, $options: 'i' } }).limit(3).lean();
    if (matches.length === 1) return about(ctx, matches[0], `${matches[0].name}:\n`);
    if (matches.length > 1) return { need: { kind: 'staff', question: `Which ${hint}?`, options: matches.map((t) => ({ label: `${t.name} (${t.employeeId})`, value: String(t._id) })) } };
    return { noData: true, text: `I could not find a teacher called "${hint}".` };
  }
  const pending = await StaffLeave.find({ school: ctx.schoolId, status: 'Pending' }).populate('teacher', 'name').sort({ fromDate: 1 }).lean();
  const now = today(ctx.now);
  const month = now.getUTCMonth() + 1;
  const year = now.getUTCFullYear();
  const slips = await Salary.find({ school: ctx.schoolId, month, year }).lean();
  const unpaid = slips.filter((s) => s.status !== 'Paid');
  const lines = [];
  if (!hasPhrase(ctx.text, SALARY_WORDS) || hasPhrase(ctx.text, LEAVE_WORDS)) {
    lines.push(pending.length
      ? `${plural(pending.length, 'staff leave request')} pending:\n${pending.slice(0, 6).map((r) => `- ${r.teacher?.name || 'Staff'}: ${r.leaveType}, ${day(r.fromDate, { short: true })} (${plural(r.days || 1, 'day')})`).join('\n')}`
      : 'No staff leave requests are pending.');
  }
  if (!hasPhrase(ctx.text, LEAVE_WORDS) || hasPhrase(ctx.text, SALARY_WORDS)) {
    lines.push(slips.length
      ? `Payroll for ${MONTHS[month - 1]} ${year}: ${plural(slips.length, 'slip')}, ${unpaid.length} not paid yet (${money(unpaid.reduce((s, x) => s + (x.netSalary || 0), 0))}).`
      : `No salary slips have been generated for ${MONTHS[month - 1]} ${year} yet.`);
  }
  return {
    text: lines.join('\n'),
    facts: { pendingLeave: pending.length, payroll: { month: `${MONTHS[month - 1]} ${year}`, slips: slips.length, unpaid: unpaid.length } },
    sources: [source('staff_leave', 'Staff leave · pending'), source('salary', `Payroll · ${MONTHS[month - 1]} ${year}`)],
  };
}

async function run(ctx) {
  let out;
  if (ctx.role === 'teacher') {
    if (!ctx.teacher) return { noData: true, text: 'I could not find your teacher record. Please ask the school office.' };
    out = await about(ctx, ctx.teacher);
  } else if (ctx.role === 'admin') {
    if (ctx.staffId) {
      const t = await Teacher.findOne({ _id: ctx.staffId, school: ctx.schoolId }).lean();
      out = t ? await about(ctx, t, `${t.name}:\n`) : { noData: true, text: 'That teacher was not found.' };
    } else out = await forAdmin(ctx);
  } else return { blocked: true, text: 'HR and salary details are only available to staff.' };
  return out.need ? out : { ...out, link: link('hr', ctx.role) };
}

module.exports = { run, needsStudent: false };
