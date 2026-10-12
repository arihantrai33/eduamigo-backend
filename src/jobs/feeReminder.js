// Daily fee reminders to parents, 7 days and 2 days before a fee is due.
// Runs at 09:00 school time. Each fee belongs to one school, so every notification is created
// inside that school and sent only to the parents linked to that student.
const cron = require('node-cron');
const Fee = require('../models/Fee');
const Student = require('../models/Student');
const ReminderLog = require('../models/ReminderLog');
const { notifyParents } = require('../services/notify');
const { schoolIdsWithFeature } = require('../services/subscription');
const { SCHOOL_TZ, toDayKey, formatDay } = require('../utils/dates');

const DAY = 24 * 60 * 60 * 1000;
const REMINDERS = [
  { days: 7, title: 'Fee due in 7 days' },
  { days: 2, title: 'Fee due in 2 days' },
];

async function sendFeeReminders(now = new Date()) {
  const today = toDayKey(now).getTime();
  let sent = 0;
  // Only schools that have the Fees module and an active subscription.
  const schools = await schoolIdsWithFeature('fees');
  if (!schools.length) return 0;
  for (const { days, title } of REMINDERS) {
    const due = new Date(today + days * DAY);
    const fees = await Fee.find({
      school: { $in: schools },
      status: { $in: ['Unpaid', 'Partial'] },
      dueDate: { $gte: due, $lt: new Date(due.getTime() + DAY) },
    });
    for (const fee of fees) {
      const balance = Math.round(((fee.amount || 0) - (fee.paidAmount || 0)) * 100) / 100;
      if (balance <= 0) continue;
      const student = await Student.findOne({ _id: fee.studentId, school: fee.school, isActive: true });
      if (!student) continue;
      // Claim this reminder first: if another run (or instance) already did, the unique key rejects us and we skip it.
      const claim = { school: fee.school, fee: fee._id, days, dueDate: fee.dueDate };
      try {
        await ReminderLog.create(claim);
      } catch (err) {
        if (err.code === 11000) continue;
        throw err;
      }
      try {
        sent += await notifyParents(student, {
          title,
          message: `${fee.feeType || 'Fee'} for ${student.name}: Rs ${balance.toLocaleString('en-IN')} is due on ${formatDay(fee.dueDate)}.`,
          type: 'Fee',
        });
      } catch (err) {
        await ReminderLog.deleteOne(claim); // nothing was sent, so a later run may try again
        throw err;
      }
    }
  }
  return sent;
}

function feeReminderJob() {
  cron.schedule('0 9 * * *', async () => {
    try {
      const sent = await sendFeeReminders();
      console.log(`Fee reminders sent: ${sent}`);
    } catch (err) {
      console.error('Fee reminder job failed:', err.message);
    }
  }, { timezone: SCHOOL_TZ });
}

module.exports = feeReminderJob;
module.exports.sendFeeReminders = sendFeeReminders;
