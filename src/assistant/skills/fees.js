// Fees skill: dues, overdue amounts, payments and receipts from Fee records.
//   students and parents: their own / their children's fees
//   admins and accountants: school or class summary, collection for a period, defaulters list

const Fee = require('../../models/Fee');
const Student = require('../../models/Student');
const { hasPhrase } = require('../text');
const { parseWhen } = require('../entities');
const { money, day, today, plural, studentLabel, link, source, escapeRegex } = require('./util');

const BUS_WORDS = ['bus', 'transport', 'van'];
const COLLECTION_WORDS = ['collection', 'collected', 'jama hua', 'jama hui', 'kitna aaya', 'received', 'income', 'aaj kitna'];
const DEFAULTER_WORDS = ['defaulter', 'defaulters', 'overdue', 'pending', 'unpaid', 'baki', 'baaki', 'bakaya', 'due', 'dues', 'nahi di', 'not paid', 'which students', 'kis kis', 'list'];
const RECEIPT_WORDS = ['receipt', 'rasid', 'raseed', 'last payment', 'paid', 'payment history'];

const balanceOf = (f) => Math.max(0, (f.amount || 0) - (f.paidAmount || 0));

function feeTypeFilter(text) {
  return hasPhrase(text, BUS_WORDS) ? { feeType: { $regex: 'bus|transport|van', $options: 'i' } } : {};
}

async function forStudent(ctx, student) {
  const now = today(ctx.now);
  const fees = await Fee.find({ school: ctx.schoolId, studentId: student._id, ...feeTypeFilter(ctx.text) }).sort({ dueDate: 1 }).lean();
  const label = studentLabel(student);
  if (!fees.length) {
    return { text: `No fees have been billed for ${label} yet.`, facts: { student: label, billed: 0 }, sources: [] };
  }
  const open = fees.filter((f) => balanceOf(f) > 0);
  const totalDue = open.reduce((s, f) => s + balanceOf(f), 0);
  const overdue = open.filter((f) => new Date(f.dueDate) < now);
  const overdueAmount = overdue.reduce((s, f) => s + balanceOf(f), 0);
  const paidTotal = fees.reduce((s, f) => s + (f.paidAmount || 0), 0);
  const payments = fees.flatMap((f) => (f.payments || []).map((p) => ({ ...p, feeType: f.feeType, feeId: f._id })))
    .sort((a, b) => new Date(b.paidAt) - new Date(a.paidAt));
  const last = payments[0];

  const lines = [];
  if (totalDue > 0) {
    lines.push(`${label}: ${money(totalDue)} is due${overdueAmount > 0 ? `, of which ${money(overdueAmount)} is overdue` : ''}.`);
    lines.push(...open.slice(0, 4).map((f) => `- ${f.feeType}: ${money(balanceOf(f))}, due ${day(f.dueDate)}${new Date(f.dueDate) < now ? ' (overdue)' : ''}`));
    if (open.length > 4) lines.push(`- and ${plural(open.length - 4, 'more fee')}`);
  } else {
    lines.push(`${label}: all billed fees are paid. Total paid: ${money(paidTotal)}.`);
  }
  if (last && (hasPhrase(ctx.text, RECEIPT_WORDS) || totalDue === 0)) {
    lines.push(`Last payment: ${money(last.amount)} on ${day(last.paidAt)} for ${last.feeType}, receipt ${last.receiptNo}.`);
  }

  return {
    text: lines.join('\n'),
    facts: {
      student: label, totalDue, overdueAmount, paidTotal,
      dues: open.slice(0, 4).map((f) => ({ feeType: f.feeType, balance: balanceOf(f), dueDate: day(f.dueDate), overdue: new Date(f.dueDate) < now })),
      lastPayment: last ? { amount: last.amount, date: day(last.paidAt), receiptNo: last.receiptNo, feeType: last.feeType } : null,
    },
    sources: (open.length ? open : fees).slice(0, 3).map((f) => source('fee', `Fee record · ${f.feeType}`, f._id, f)),
    actions: totalDue > 0 && ctx.role === 'parent' && ctx.entitlements?.features?.includes('online_payments') ? [{ label: 'Pay now', path: '/parent/fee' }] : [],
  };
}

async function studentIdsForClass(ctx, cls) {
  if (!cls) return null;
  const q = { school: ctx.schoolId, isActive: true, class: { $regex: `^${escapeRegex(cls.class)}$`, $options: 'i' } };
  if (cls.section) q.section = cls.section;
  return (await Student.find(q).select('_id').lean()).map((s) => s._id);
}

async function forSchool(ctx) {
  const now = today(ctx.now);
  const ids = await studentIdsForClass(ctx, ctx.cls);
  const scope = ctx.cls ? `Class ${ctx.cls.class}${ctx.cls.section ? `-${ctx.cls.section}` : ''}` : 'the school';
  const base = { school: ctx.schoolId, ...(ids ? { studentId: { $in: ids } } : {}), ...feeTypeFilter(ctx.text) };
  const busOnly = !!base.feeType;

  // Collection in a period (default today).
  if (hasPhrase(ctx.text, COLLECTION_WORDS)) {
    const when = parseWhen(ctx.text, { direction: 'past', now: ctx.now }) || { day: now, label: 'today' };
    const from = when.day || when.from || now;
    const to = new Date((when.day || when.to || now).getTime() + 86400000);
    const rows = await Fee.aggregate([
      { $match: base }, { $unwind: '$payments' },
      { $match: { 'payments.paidAt': { $gte: from, $lt: to } } },
      { $group: { _id: null, total: { $sum: '$payments.amount' }, count: { $sum: 1 } } },
    ]);
    const total = rows[0]?.total || 0;
    const count = rows[0]?.count || 0;
    return {
      text: `Fee collection for ${scope} ${when.label}: ${money(total)} from ${plural(count, 'payment')}.`,
      facts: { scope, period: when.label, collected: total, payments: count },
      sources: [source('report', `Fee payments · ${when.label}`)],
      link: link('fees', ctx.role),
    };
  }

  const fees = await Fee.find({ ...base, status: { $ne: 'Paid' } }).populate('studentId', 'name class section isActive').lean();
  const open = fees.filter((f) => balanceOf(f) > 0 && f.studentId?.isActive !== false);
  const totalDue = open.reduce((s, f) => s + balanceOf(f), 0);
  const overdue = open.filter((f) => new Date(f.dueDate) < now);
  const overdueAmount = overdue.reduce((s, f) => s + balanceOf(f), 0);

  const byStudent = new Map();
  for (const f of (hasPhrase(ctx.text, ['overdue', 'defaulter', 'defaulters']) ? overdue : open)) {
    if (!f.studentId) continue;
    const k = String(f.studentId._id);
    const row = byStudent.get(k) || { name: f.studentId.name, cls: `${f.studentId.class}-${f.studentId.section}`, balance: 0 };
    row.balance += balanceOf(f);
    byStudent.set(k, row);
  }
  const top = [...byStudent.values()].sort((a, b) => b.balance - a.balance);
  const what = busOnly ? 'bus fees' : 'fees';

  if (!open.length) {
    return { text: `No ${what} are pending for ${scope}.`, facts: { scope, totalDue: 0 }, sources: [source('report', `Fee records · ${scope}`)], link: link('fees', ctx.role) };
  }
  const lines = [`Pending ${what} for ${scope}: ${money(totalDue)} from ${plural(byStudent.size, 'student')}${overdueAmount ? `; ${money(overdueAmount)} is overdue` : ''}.`];
  if (hasPhrase(ctx.text, DEFAULTER_WORDS) || ctx.cls || busOnly) {
    lines.push(...top.slice(0, 10).map((r) => `- ${r.name} (${r.cls}): ${money(r.balance)}`));
    if (top.length > 10) lines.push(`- and ${plural(top.length - 10, 'more student')}`);
  }
  return {
    text: lines.join('\n'),
    facts: { scope, what, totalDue, overdueAmount, students: byStudent.size, list: top.slice(0, 10) },
    sources: [source('report', `Fee records · ${scope}${busOnly ? ' · bus' : ''}`)],
    link: link('fees', ctx.role),
  };
}

async function run(ctx) {
  if (ctx.students?.length) {
    const parts = [];
    for (const s of ctx.students) parts.push(await forStudent(ctx, s));
    return {
      text: parts.map((p) => p.text).join('\n\n'),
      facts: { children: parts.map((p) => p.facts) },
      sources: parts.flatMap((p) => p.sources),
      link: link('fees', ctx.role),
      actions: parts.flatMap((p) => p.actions || []).slice(0, 1),
    };
  }
  if (['admin', 'accountant'].includes(ctx.role)) return forSchool(ctx);
  return { noData: true, text: 'I could not find a student record linked to your account. Please ask the school office to link it.' };
}

module.exports = { run, needsStudent: true, staffCanName: true };
