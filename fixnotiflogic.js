const fs = require('fs');
const path = './src/controllers/attendanceController.js';
let code = fs.readFileSync(path, 'utf8');

const oldBlock = `      // Parent ko notify karo agar Absent/Late
      if (r.status !== 'Present') {
        const parent = await Parent.findOne({ children: r.studentId });
        if (parent) {
          const student = await Student.findById(r.studentId);
          await Notification.create({
            title:      \`Attendance: \${r.status}\`,
            message:    \`\${student?.name || 'Your child'} was marked \${r.status} on \${date}.\`,
            targetRole: 'parent',
            targetId:   parent._id,
            type:       'Info',
          });
        }
      }`;

const newBlock = `      // Parent ko notify karo agar Absent/Late — no duplicates
      if (r.status !== 'Present') {
        const parent = await Parent.findOne({ children: r.studentId });
        if (parent) {
          const student = await Student.findById(r.studentId);
          const alreadyNotified = await Notification.findOne({
            targetId: parent._id,
            title: \`Attendance: \${r.status}\`,
            message: { $regex: date }
          });
          if (!alreadyNotified) {
            await Notification.create({
              title:      \`Attendance: \${r.status}\`,
              message:    \`\${student?.name || 'Your child'} was marked \${r.status} on \${date}.\`,
              targetRole: 'parent',
              targetId:   parent._id,
              type:       'Info',
            });
          }
        }
      }`;

code = code.replace(oldBlock, newBlock);
fs.writeFileSync(path, code);
console.log('Fixed');
