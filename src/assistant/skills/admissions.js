// Admissions skill (admins): enquiries and applications from Admission, by status, for a period
// (default this week), plus follow-ups due.

const Admission = require('../../models/Admission');
const { parseWhen } = require('../entities');
const { day, today, addDays, plural, link, source } = require('./util');

const OPEN = ['Enquiry', 'Applied', 'Test Scheduled', 'Approved'];

async function run(ctx) {
  const when = parseWhen(ctx.text, { direction: 'past', now: ctx.now });
  const now = today(ctx.now);
  const monday = addDays(now, -((now.getUTCDay() + 6) % 7));
  const from = when?.day || when?.from || monday;
  const to = addDays(when?.day || when?.to || now, 1);
  const label = when?.label || 'this week';

  const rows = await Admission.aggregate([
    { $match: { school: ctx.schoolId, createdAt: { $gte: from, $lt: to } } },
    { $group: { _id: '$status', n: { $sum: 1 } } },
  ]);
  const byStatus = Object.fromEntries(rows.map((r) => [r._id, r.n]));
  const total = rows.reduce((s, r) => s + r.n, 0);
  const followUps = await Admission.countDocuments({ school: ctx.schoolId, status: { $in: OPEN }, followUpDate: { $lte: now } });
  const openTotal = await Admission.countDocuments({ school: ctx.schoolId, status: { $in: OPEN } });

  const lines = [total
    ? `${plural(total, 'new enquiry', 'new enquiries')} ${label} (${day(from, { short: true })} to ${day(addDays(to, -1), { short: true })}): ${Object.entries(byStatus).map(([s, n]) => `${s} ${n}`).join(', ')}.`
    : `No new enquiries ${label}.`];
  lines.push(`${plural(openTotal, 'application')} ${openTotal === 1 ? 'is' : 'are'} still open; ${plural(followUps, 'follow-up')} ${followUps === 1 ? 'is' : 'are'} due today or earlier.`);
  return {
    text: lines.join('\n'),
    facts: { period: label, newEnquiries: total, byStatus, open: openTotal, followUpsDue: followUps },
    sources: [source('admissions', `Admissions · ${label}`)],
    link: link('admissions', ctx.role),
  };
}

module.exports = { run, needsStudent: false };
