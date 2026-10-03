/* eslint-disable no-console */
// Local demo: starts the API on a throwaway in-memory MongoDB filled with demo schools, so every
// role and plan can be tried on localhost without touching a real database.
//
//   npm run demo            (then, in the frontend folder: npm run dev)
//
// Everything is deleted when the process stops. Never uses MONGO_URI.

process.env.NODE_ENV = 'development';
process.env.DISABLE_JOBS = 'true';
process.env.EMAIL_PROVIDER = 'log';            // reset codes are printed in this terminal
process.env.JWT_SECRET = process.env.DEMO_JWT_SECRET || 'local-demo-secret-not-for-production-use-only';
delete process.env.CORS_ORIGINS;               // allow the local frontend

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const PASSWORD = 'Demo@1234';
const DAY = 86400000;

async function seed() {
  const User = require('../models/User');
  const School = require('../models/School');
  const SchoolClass = require('../models/SchoolClass');
  const { hashPassword } = require('../services/credentials');
  const { onboardSchool } = require('../services/schoolOnboarding');
  const { createSession } = require('../services/academic');
  const { createStudentWithAccounts } = require('../services/studentService');
  const { createTeacherWithAccount } = require('../services/teacherService');
  const hashed = await hashPassword(PASSWORD);
  const rows = [];

  // Every demo account gets the same known password and skips the first-login password change.
  const ready = async (userId) => User.updateOne({ _id: userId }, { password: hashed, mustChangePassword: false });

  await User.create({ name: 'EduAmigo Owner', email: 'owner@eduamigo.demo', role: 'superadmin', password: hashed });
  rows.push({ school: '(platform)', role: 'Super Admin', loginId: 'owner@eduamigo.demo', where: 'POST /api/platform/login' });

  async function demoSchool({ name, code, city, plan, color, accent, logoUrl, appName, tagline, subscription, classes, teacher, students }) {
    const { school, admin } = await onboardSchool({ name, code, city, plan, adminName: `${code} Principal`, adminEmail: `admin@${code.toLowerCase()}.demo` });
    await ready(admin._id);
    const branding = { appName: appName || name, primaryColor: color, accentColor: accent || '', logoUrl: logoUrl || '', tagline: tagline || '' };
    await School.updateOne({ _id: school._id }, { branding, ...(subscription ? Object.fromEntries(Object.entries(subscription).map(([k, v]) => [`subscription.${k}`, v])) : {}) });
    rows.push({ school: code, role: `Admin (${plan})`, loginId: admin.email, where: 'Admin tab' });

    await createSession(school._id, { name: '2026-27' });
    const t = await createTeacherWithAccount(school._id, { name: teacher, email: `teacher@${code.toLowerCase()}.demo`, phone: '9000000001', employeeId: `${code}-T1`, subjects: ['Mathematics', 'Science'] });
    await ready(t.teacher.userId);
    rows.push({ school: code, role: 'Teacher', loginId: `teacher@${code.toLowerCase()}.demo`, where: 'Teacher tab' });

    for (const c of classes) {
      await SchoolClass.create({
        school: school._id, name: c, displayName: `Class ${c}`, order: Number(c) || 0,
        sections: [{ name: 'A', classTeacher: c === classes[0] ? t.teacher._id : null }, { name: 'B' }],
        subjects: ['English', 'Hindi', 'Mathematics', 'Science', 'Social Science'],
      });
    }
    await require('../models/Teacher').updateOne({ _id: t.teacher._id }, { $addToSet: { assignedClasses: `${classes[0]}-A` } });

    const parentsSeen = new Set();
    for (const s of students) {
      const { student, credentials } = await createStudentWithAccounts(school._id, { ...s, class: classes[0], section: 'A' });
      await ready(student.userId);
      rows.push({ school: code, role: `Student (${student.name})`, loginId: student.admissionNo, where: 'Student tab' });
      if (credentials.parent) await ready(student.parentUserId);
      if (s.parentPhone && !parentsSeen.has(s.parentPhone)) {
        parentsSeen.add(s.parentPhone);
        rows.push({ school: code, role: `Parent (${s.parentName})`, loginId: s.parentPhone, where: 'Parent tab' });
      }
    }
    return school;
  }

  await demoSchool({
    name: 'Green Valley Public School', code: 'GVPS', city: 'Jaipur', plan: 'premium', color: '#0A7E8C',
    classes: ['9', '10'], teacher: 'Anita Verma',
    students: [
      { name: 'Riya Sharma', parentName: 'Meera Sharma', parentPhone: '9876543210', gender: 'Female' },
      { name: 'Kabir Sharma', parentName: 'Meera Sharma', parentPhone: '9876543210', gender: 'Male' },   // sibling: same parent login
      { name: 'Aarav Gupta', parentName: 'Rohit Gupta', parentPhone: '9812345678', gender: 'Male' },
    ],
  });
  await demoSchool({
    name: 'Sunrise Convent School', code: 'SCS', city: 'Lucknow', plan: 'basic', color: '#C2410C',
    subscription: { status: 'active', currentPeriodEnd: null },
    classes: ['5'], teacher: 'Rahul Mishra',
    students: [{ name: 'Ishita Singh', parentName: 'Pooja Singh', parentPhone: '9123456780', gender: 'Female' }],
  });
  await demoSchool({
    name: 'Little Flower School', code: 'LFS', city: 'Indore', plan: 'standard', color: '#7C3AED',
    subscription: { status: 'trial', trialEndsAt: new Date(Date.now() - 10 * DAY) },   // trial over: read-only
    classes: ['3'], teacher: 'Sana Khan',
    students: [{ name: 'Vihaan Jain', parentName: 'Neha Jain', parentPhone: '9988776655', gender: 'Male' }],
  });

  // Allied International School: two campuses, each its own school (own code, students and data),
  // same name and theme. Logo and motto are from the school's public website
  // (alliedinternationalschool.com) for this local demo only; saffron and gold theme.
  const allied = {
    appName: 'Allied International School', plan: 'premium', color: '#D9480F', accent: '#F2B705',
    logoUrl: 'http://www.alliedinternationalschool.com/images/logo.jpg', tagline: 'सा विद्या या विमुक्तये',
    subscription: { status: 'active', currentPeriodEnd: null },
  };
  await demoSchool({
    ...allied, name: 'Allied International School, Gaya', code: 'AISGAYA', city: 'Gaya',
    classes: ['6', '7', '8'], teacher: 'Sunita Prasad',
    students: [
      { name: 'Aditya Kumar', parentName: 'Rakesh Kumar', parentPhone: '9431012345', gender: 'Male' },
      { name: 'Ananya Kumari', parentName: 'Rakesh Kumar', parentPhone: '9431012345', gender: 'Female' },  // sibling
      { name: 'Priyanshu Raj', parentName: 'Manoj Raj', parentPhone: '9835012345', gender: 'Male' },
    ],
  });
  await demoSchool({
    ...allied, name: 'Allied International School, Chakand', code: 'AISCHAKAND', city: 'Chakand, Gaya',
    classes: ['1', '2', '3'], teacher: 'Ravi Ranjan',
    students: [
      { name: 'Khushi Kumari', parentName: 'Sanjay Yadav', parentPhone: '9472012345', gender: 'Female' },
      { name: 'Arnav Singh', parentName: 'Vikash Singh', parentPhone: '9304012345', gender: 'Male' },
    ],
  });
  return rows;
}

async function main() {
  const port = Number(process.env.PORT) || 8000;
  console.log('Starting a temporary database (first run downloads MongoDB, about a minute)...');
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
  const rows = await seed();

  require('../app')().listen(port, () => {
    console.log(`\nEduAmigo demo API on http://localhost:${port}  (data is temporary)`);
    console.log(`Every password: ${PASSWORD}\n`);
    console.table(rows);
    console.log(`
Schools to try:
  GVPS  Premium, trial    -> every module, branded teal
  SCS   Basic, paid       -> fees, exams, transport, chat hidden
  LFS   Standard, expired -> read-only: viewing works, saving is blocked, banner for staff
  AISGAYA, AISCHAKAND     -> Allied International School, two campuses (search "allied"), saffron and gold with logo

Frontend: cd ../eduamigo-frontend && npm run dev   then open http://localhost:5173
School link test: http://localhost:5173/s/GVPS
Press Ctrl+C to stop (all demo data is deleted).`);
  });

  const stop = async () => {
    await mongoose.disconnect().catch(() => {});
    await mongo.stop().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((err) => {
  console.error('Demo failed to start:', err);
  process.exit(1);
});
