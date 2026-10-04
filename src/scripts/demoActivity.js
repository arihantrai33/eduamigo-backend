// A month of realistic school activity for a DEMO school, so every EduAmigo Ask topic has something to
// answer from: fees (paid, part-paid, overdue, bus), attendance, timetable, exams and published results,
// homework, buses on a live trip, notices, calendar, leave, staff leave, salaries, library and admissions.
//
// Dates are relative to today, and the "random" parts use a fixed seed per school, so every demo run
// looks the same. Only ever used by the local demo (npm run demo), never on real schools.

const crypto = require('crypto');
const Student = require('../models/Student');
const Teacher = require('../models/Teacher');
const User = require('../models/User');
const Fee = require('../models/Fee');
const Attendance = require('../models/Attendance');
const Timetable = require('../models/Timetable');
const ExamSchedule = require('../models/ExamSchedule');
const ExamResult = require('../models/ExamResult');
const Note = require('../models/Note');
const Transport = require('../models/Transport');
const Announcement = require('../models/Announcement');
const Event = require('../models/Event');
const LeaveRequest = require('../models/LeaveRequest');
const StaffLeave = require('../models/StaffLeave');
const Salary = require('../models/Salary');
const Library = require('../models/Library');
const Admission = require('../models/Admission');
const { toDayKey, currentAcademicYear } = require('../utils/dates');

const DAY = 86400000;
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const SUBJECTS = ['English', 'Hindi', 'Mathematics', 'Science', 'Social Science', 'Computer'];
const TIMES = [['08:00', '08:40'], ['08:40', '09:20'], ['09:20', '10:00'], ['10:20', '11:00'], ['11:00', '11:40'], ['11:40', '12:20']];

// Small deterministic random generator (mulberry32).
function rng(seedText) {
  let a = [...seedText].reduce((h, c) => (Math.imul(h ^ c.charCodeAt(0), 2654435761) >>> 0), 1779033703);
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function seedActivity(school, { stops = ['School Gate', 'Main Market', 'Railway Station Road', 'Civil Lines'] } = {}) {
  const rand = rng(String(school.code || school._id));
  const today = toDayKey(new Date());
  const at = (n) => new Date(today.getTime() + n * DAY);
  const year = currentAcademicYear();
  const students = await Student.find({ school: school._id, isActive: true }).sort({ name: 1 });
  const teachers = await Teacher.find({ school: school._id, isActive: true });
  const admin = await User.findOne({ school: school._id, role: 'admin' });
  const teacher = teachers[0];
  if (!students.length) return;
  const sections = [...new Map(students.map((s) => [`${s.class}-${s.section}`, { class: s.class, section: s.section }])).values()];

  // Buses: one on a live trip, one idle; students split between them.
  const mk = (name, order, status) => ({ name, latitude: 24.75 + order / 100, longitude: 84.99 + order / 100, order, status, estimatedTime: `07:${String(10 + order * 8).padStart(2, '0')}` });
  const bus1 = await Transport.create({
    school: school._id, busNumber: 'BR02 PA 4521', driverName: 'Ramesh Yadav', driverPhone: '9000011111', routeName: `${stops[1]} Route`,
    driverToken: crypto.randomBytes(16).toString('hex'), trackingId: crypto.randomBytes(8).toString('hex'), busStatus: 'On Route', currentStopIndex: 1,
    tripStartedAt: new Date(Date.now() - 25 * 60000),
    stops: [mk(stops[0], 0, 'Departed'), mk(stops[1], 1, 'Live'), mk(stops[2], 2, 'Pending'), mk('School', 3, 'Pending')],
  });
  const bus2 = await Transport.create({
    school: school._id, busNumber: 'BR02 PB 7730', driverName: 'Sunil Paswan', driverPhone: '9000022222', routeName: `${stops[3]} Route`,
    driverToken: crypto.randomBytes(16).toString('hex'), trackingId: crypto.randomBytes(8).toString('hex'), busStatus: 'Idle',
    stops: [mk(stops[3], 0, 'Pending'), mk('Gandhi Maidan', 1, 'Pending'), mk('School', 2, 'Pending')],
  });
  const onBus = new Map();
  for (const [i, s] of students.entries()) {
    const bus = i % 4 === 3 ? null : (i % 2 === 0 ? bus1 : bus2);
    if (!bus) continue;
    onBus.set(String(s._id), bus);
    await Student.updateOne({ _id: s._id }, { bus: bus._id });
    await Transport.updateOne({ _id: bus._id }, { $addToSet: { assignedStudents: s._id } });
  }

  // Fees: term 1 paid with a receipt, term 2 due soon (some part-paid), bus fee (one overdue).
  let receipt = 100;
  for (const [i, s] of students.entries()) {
    receipt += 1;
    await Fee.create({
      school: school._id, studentId: s._id, feeType: 'Tuition Term 1', amount: 9000, paidAmount: 9000, status: 'Paid', academicYear: year,
      dueDate: at(-70), paidDate: at(-75), receiptNo: `R-${receipt}`,
      payments: [{ amount: 9000, mode: 'UPI', receiptNo: `R-${receipt}`, paidAt: at(-75), collectedBy: admin?._id }],
    });
    const part = i % 3 === 1 ? 4500 : 0;
    receipt += 1;
    await Fee.create({
      school: school._id, studentId: s._id, feeType: 'Tuition Term 2', amount: 9000, paidAmount: part, status: part ? 'Partial' : 'Unpaid', academicYear: year,
      dueDate: at(11), ...(part ? { payments: [{ amount: part, mode: 'Cash', receiptNo: `R-${receipt}`, paidAt: at(0), collectedBy: admin?._id }] } : {}),
    });
    await Student.updateOne({ _id: s._id }, { feeStatus: part ? 'Partial' : 'Pending' });
    if (onBus.has(String(s._id))) {
      const overdue = i % 2 === 0;
      await Fee.create({ school: school._id, studentId: s._id, feeType: 'Bus fee (October)', amount: 1500, paidAmount: 0, status: 'Unpaid', academicYear: year, dueDate: at(overdue ? -4 : 6) });
    }
  }

  // Attendance: every school day of the last 45 days up to today; the last section is not marked today yet.
  const monthStart = at(-45);
  const docs = [];
  for (let d = monthStart; d <= today; d = new Date(d.getTime() + DAY)) {
    if (d.getUTCDay() === 0) continue;
    for (const s of students) {
      if (d.getTime() === today.getTime() && `${s.class}-${s.section}` === `${sections[sections.length - 1].class}-${sections[sections.length - 1].section}` && sections.length > 1) continue;
      const r = rand();
      const status = r < 0.86 ? 'Present' : r < 0.94 ? 'Absent' : 'Late';
      docs.push({ school: school._id, studentId: s._id, class: s.class, section: s.section, date: d, status, markedBy: teacher?.userId });
    }
  }
  await Attendance.insertMany(docs);

  // Timetable: six periods a day, Monday to Saturday, for every section in use.
  for (const sec of sections) {
    for (const [di, day] of WEEKDAYS.entries()) {
      const periods = TIMES.map(([start, end], p) => {
        const subject = SUBJECTS[(p + di) % SUBJECTS.length];
        return { periodNo: p + 1, subject, startTime: start, endTime: end, teacher: ['Mathematics', 'Science'].includes(subject) ? teacher?._id : undefined };
      });
      await Timetable.create({ school: school._id, class: sec.class, section: sec.section, day, periods, classTeacher: teacher?._id });
    }
  }

  // Exams: Unit Test 2 starts tomorrow; Unit Test 1 results are published.
  for (const sec of sections) {
    const upcoming = [['Mathematics', 1], ['Science', 3], ['English', 5]];
    for (const [subject, n] of upcoming) {
      await ExamSchedule.create({ school: school._id, title: 'Unit Test 2', examType: 'Unit Test', term: 'Term 2', subject, class: sec.class, section: sec.section, date: at(n), startTime: '10:00', endTime: '11:30', totalMarks: 50, academicYear: year });
    }
    const past = await ExamSchedule.create({ school: school._id, title: 'Unit Test 1', examType: 'Unit Test', term: 'Term 1', subject: 'Mathematics', class: sec.class, section: sec.section, date: at(-24), totalMarks: 50, academicYear: year });
    for (const s of students.filter((x) => x.class === sec.class && x.section === sec.section)) {
      for (const subject of ['Mathematics', 'Science', 'English']) {
        const marks = 28 + Math.floor(rand() * 22);
        await ExamResult.create({
          school: school._id, exam: subject === 'Mathematics' ? past._id : undefined, student: s._id, teacher: teacher?._id, examName: 'Unit Test 1', examType: 'Unit Test', term: 'Term 1',
          subject, class: s.class, section: s.section, academicYear: year, totalMarks: 50, marksObtained: marks, percentage: Math.round((marks / 50) * 100),
          grade: marks >= 45 ? 'A1' : marks >= 40 ? 'A2' : marks >= 35 ? 'B1' : 'B2', examDate: at(-24),
        });
      }
    }
  }

  // Homework and notes.
  for (const sec of sections) {
    await Note.create({ school: school._id, title: 'Fractions: practice worksheet', subject: 'Mathematics', type: 'Assignment', class: sec.class, section: sec.section, dueDate: at(1), teacherName: teacher?.name, uploadedBy: teacher?.userId, fileUrl: 'https://example.com/demo.pdf', processing: { status: 'skipped' } });
    await Note.create({ school: school._id, title: 'My Favourite Festival (essay)', subject: 'English', type: 'Assignment', class: sec.class, section: sec.section, dueDate: at(3), teacherName: teacher?.name, uploadedBy: teacher?.userId, fileUrl: 'https://example.com/demo.pdf', processing: { status: 'skipped' } });
    await Note.create({ school: school._id, title: 'Plants and Photosynthesis: chapter notes', subject: 'Science', type: 'Notes', class: sec.class, section: '', teacherName: teacher?.name, uploadedBy: teacher?.userId, fileUrl: 'https://example.com/demo.pdf', processing: { status: 'skipped' } });
  }

  // Notice board and calendar.
  await Announcement.create({ school: school._id, title: 'Diwali and Chhath holidays', message: 'School will remain closed for Diwali and Chhath. Classes resume on the Monday after Chhath. Holiday homework is on the app.', priority: 'important', isPinned: true, targetRole: 'all', createdBy: admin?._id });
  await Announcement.create({ school: school._id, title: 'Unit Test 2 date sheet', message: 'Unit Test 2 begins tomorrow at 10:00. Students must carry their admit cards.', priority: 'normal', targetRole: 'all', createdBy: admin?._id });
  await Announcement.create({ school: school._id, title: 'Parent-Teacher Meeting', message: 'PTM for all classes on Saturday from 9:00 to 12:00.', priority: 'normal', targetRole: 'parent', createdBy: admin?._id });
  const saturday = at(((6 - today.getUTCDay() + 7) % 7) || 7);
  await Event.create({ school: school._id, title: 'Parent-Teacher Meeting', type: 'ptm', date: saturday, targetRole: 'all', createdBy: admin?._id });
  await Event.create({ school: school._id, title: 'Annual Sports Day', type: 'sports', date: at(12), targetRole: 'all', createdBy: admin?._id });
  await Event.create({ school: school._id, title: 'Diwali vacation', type: 'holiday', date: at(31), endDate: at(36), targetRole: 'all', createdBy: admin?._id });

  // Leave: one approved, one waiting for the class teacher.
  const [first, second] = students;
  if (first?.userId) {
    await LeaveRequest.create({ school: school._id, requestedBy: first.userId, role: 'student', name: first.name, studentId: first._id, class: first.class, section: first.section, leaveType: 'Sick', fromDate: at(-6), toDate: at(-5), days: 2, reason: 'Fever', status: 'Approved', reviewedBy: teacher?.userId, reviewedAt: at(-6) });
  }
  if (second?.parentUserId) {
    await LeaveRequest.create({ school: school._id, requestedBy: second.parentUserId, role: 'parent', name: second.name, studentId: second._id, class: second.class, section: second.section, leaveType: 'Family', fromDate: at(2), toDate: at(3), days: 2, reason: 'Family function', status: 'Pending' });
  }

  // Staff leave and payroll.
  for (const t of teachers) {
    await StaffLeave.create({ school: school._id, teacher: t._id, leaveType: 'Casual', fromDate: at(-20), toDate: at(-19), reason: 'Personal work', status: 'Approved', approvedBy: admin?._id });
    await StaffLeave.create({ school: school._id, teacher: t._id, leaveType: 'Sick', fromDate: at(4), toDate: at(4), reason: 'Medical appointment', status: 'Pending' });
    const m = today.getUTCMonth() + 1;
    const y = today.getUTCFullYear();
    const prev = m === 1 ? { month: 12, year: y - 1 } : { month: m - 1, year: y };
    await Salary.create({ school: school._id, teacher: t._id, ...prev, basicSalary: 28000, allowances: 3000, deductions: 1200, status: 'Paid', paidOn: new Date(Date.UTC(y, m - 1, 1)) });
    await Salary.create({ school: school._id, teacher: t._id, month: m, year: y, basicSalary: 28000, allowances: 3000, deductions: 1200, status: 'Pending' });
  }

  // Library catalogue.
  const books = [
    ['Wings of Fire', 'A. P. J. Abdul Kalam', 'Biography', 4, 1], ['Harry Potter and the Philosopher\'s Stone', 'J. K. Rowling', 'Fiction', 3, 0],
    ['Godan', 'Munshi Premchand', 'Fiction', 2, 2], ['Idgah and Other Stories', 'Munshi Premchand', 'Fiction', 3, 1],
    ['NCERT Science Class 8', 'NCERT', 'Textbook', 10, 6], ['Concepts of Physics', 'H. C. Verma', 'Science', 2, 1],
    ['The Story of My Experiments with Truth', 'M. K. Gandhi', 'Biography', 2, 2], ['Python for Kids', 'Jason Briggs', 'Science', 2, 2],
  ];
  for (const [title, author, category, totalCopies, available] of books) {
    await Library.create({ school: school._id, title, author, category, totalCopies, available, issued: totalCopies - available, addedBy: admin?._id });
  }

  // Admissions this week.
  const enquiries = [['Saanvi Mishra', '1', 'Enquiry', 0], ['Reyansh Kumar', '3', 'Applied', -1], ['Myra Sinha', '2', 'Test Scheduled', -2], ['Advik Ranjan', '6', 'Enquiry', -3], ['Kiara Prasad', 'LKG', 'Approved', -9]];
  for (const [i, [studentName, classApplied, status, d]] of enquiries.entries()) {
    await Admission.create({
      school: school._id, applicationNo: `ENQ-${school.code}-${101 + i}`, academicYear: year, classApplied, studentName, parentName: `Parent of ${studentName.split(' ')[0]}`,
      parentPhone: `90000${String(30000 + i)}`, source: i % 2 ? 'Website' : 'Walk-in', status, followUpDate: status === 'Enquiry' ? at(0) : undefined,
      history: [{ status, at: at(d), by: admin?._id }], createdAt: at(d), updatedAt: at(d),
    });
  }
}

module.exports = { seedActivity };
