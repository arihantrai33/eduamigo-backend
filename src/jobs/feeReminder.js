const cron = require('node-cron');
const Fee = require('../models/Fee');
const Parent = require('../models/Parent');
const Student = require('../models/Student');
const Notification = require('../models/Notification');

const feeReminderJob = () => {
  // Runs every day at 9:00 AM
  cron.schedule('0 9 * * *', async () => {
    console.log('Running fee reminder job...');

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const sevenDaysLater = new Date(today);
    sevenDaysLater.setDate(today.getDate() + 7);

    const twoDaysLater = new Date(today);
    twoDaysLater.setDate(today.getDate() + 2);

    try {
      const unpaidFees = await Fee.find({ status: 'Unpaid' });

      for (const fee of unpaidFees) {
        const dueDate = new Date(fee.dueDate);
        dueDate.setHours(0, 0, 0, 0);

        const parent = await Parent.findOne({ children: fee.studentId });
        if (!parent) continue;

        const student = await Student.findById(fee.studentId);
        const studentName = student?.name || 'Your child';

        // 7 days before due date
        if (dueDate.getTime() === sevenDaysLater.getTime()) {
          await Notification.create({
            title: 'Fee Due Reminder',
            message: `Fee of ₹${fee.amount} for ${studentName} (${fee.month} ${fee.year}) is due in 7 days on ${dueDate.toDateString()}. Please make the payment on time.`,
            targetRole: 'parent',
            targetId: parent._id,
            type: 'Fee'
          });
          console.log(`7-day reminder sent for student: ${studentName}`);
        }

        // 2 days before due date
        if (dueDate.getTime() === twoDaysLater.getTime()) {
          await Notification.create({
            title: 'Urgent: Fee Due in 2 Days',
            message: `Fee of ₹${fee.amount} for ${studentName} (${fee.month} ${fee.year}) is due in 2 days on ${dueDate.toDateString()}. Please make the payment immediately to avoid late charges.`,
            targetRole: 'parent',
            targetId: parent._id,
            type: 'Fee'
          });
          console.log(`2-day reminder sent for student: ${studentName}`);
        }
      }
    } catch (error) {
      console.error('Fee reminder job error:', error.message);
    }
  });
};

module.exports = feeReminderJob;