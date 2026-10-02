const mongoose = require('mongoose');
const { connect, disconnect, clear } = require('./helpers');
const { migrate } = require('../src/scripts/migrate');

beforeAll(connect);
afterAll(disconnect);
beforeEach(clear);

const oid = () => new mongoose.Types.ObjectId();

test('backfills school ids, normalizes classes, removes leaky notifications, dedupes attendance', async () => {
  const db = mongoose.connection.db;
  const school = oid();
  const adminId = oid();
  const teacherUserId = oid();
  const studentId = oid();

  await db.collection('users').insertMany([
    { _id: adminId, name: 'Admin', email: 'ADMIN@X.COM', role: 'admin', school, password: 'x' },
    { _id: teacherUserId, name: 'T', email: 't@x.com', role: 'teacher', school, password: 'x' },
  ]);
  await db.collection('students').insertOne({ _id: studentId, name: 'S', class: 'Class 10', section: 'a', school, rollNumber: '1', email: 's@x.com', phone: '1' });
  await db.collection('teachers').insertOne({ _id: oid(), name: 'T', email: 'T@x.com', assignedClasses: ['10-a', '10-A'], school, employeeId: 'E1', phone: '1' });
  await db.collection('fees').insertOne({ studentId, feeType: 'Tuition', amount: 100, dueDate: new Date() });
  await db.collection('notes').insertOne({ title: 'N', subject: 'Sci', class: '10-A', uploadedBy: teacherUserId, type: 'Notes' });
  await db.collection('notifications').insertMany([
    { title: 'Attendance: Absent', message: 'X was absent', targetRole: 'parent' },
    { title: 'Holiday', message: 'School closed', targetRole: 'all', createdBy: adminId },
  ]);
  // Legacy databases do not have the new unique index yet.
  await db.collection('attendances').dropIndexes().catch(() => {});
  await db.collection('attendances').insertMany([
    { studentId, date: new Date('2026-09-01T00:00:00Z'), status: 'Absent', class: '10', section: 'A', updatedAt: new Date(1) },
    { studentId, date: new Date('2026-09-01T00:00:00Z'), status: 'Present', class: '10', section: 'A', updatedAt: new Date(2) },
  ]);

  await db.collection('messages').insertMany([
    { roomId: 'r1', senderId: adminId, receiverId: teacherUserId, text: 'old', createdAt: new Date(1000) },
    { roomId: 'r1', senderId: teacherUserId, receiverId: adminId, text: 'newest', createdAt: new Date(2000) },
  ]);
  const dry = await migrate({ apply: false, quiet: true });
  expect(dry['fees.school_backfilled']).toBe(1);
  expect(await db.collection('fees').countDocuments({ school: { $exists: true } })).toBe(0);

  await migrate({ apply: true, quiet: true });

  expect((await db.collection('users').findOne({ _id: adminId })).email).toBe('admin@x.com');
  const s = await db.collection('students').findOne({ _id: studentId });
  expect([s.class, s.section]).toEqual(['10', 'A']);
  expect((await db.collection('teachers').findOne({})).assignedClasses).toEqual(['10-A']);
  expect(String((await db.collection('fees').findOne({})).school)).toBe(String(school));
  const note = await db.collection('notes').findOne({});
  expect([note.class, note.section, note.processing.status]).toEqual(['10', 'A', 'pending']);
  const notifs = await db.collection('notifications').find({}).toArray();
  expect(notifs.map((n) => n.title)).toEqual(['Holiday']);
  const att = await db.collection('attendances').find({}).toArray();
  expect(att).toHaveLength(1);
  expect(att[0].status).toBe('Present');

  const conv = await db.collection('conversations').findOne({ roomId: 'r1' });
  expect(conv.lastText).toBe('newest');
  const second = await migrate({ apply: true, quiet: true });
  expect(second['fees.school_backfilled']).toBeUndefined();
});

test('recalculates hand-typed fee status from fee records and reports accounts without a profile', async () => {
  const db = mongoose.connection.db;
  const school = oid();
  const [billed, unbilled, orphanUser] = [oid(), oid(), oid()];
  await db.collection('students').insertMany([
    { _id: billed, name: 'Billed', email: 'billed@x.com', class: '7', section: 'A', school, rollNumber: '1', feeStatus: 'Paid' },
    { _id: unbilled, name: 'Unbilled', email: 'unbilled@x.com', class: '7', section: 'A', school, rollNumber: '2', feeStatus: 'Paid' },
  ]);
  await db.collection('fees').insertOne({ studentId: billed, school, feeType: 'Tuition', amount: 1000, paidAmount: 400, dueDate: new Date() });
  await db.collection('users').insertOne({ _id: orphanUser, name: 'Old Teacher', email: 'old@x.com', role: 'teacher', school, password: 'x' });

  const dry = await migrate({ apply: false, quiet: true });
  expect(dry['students.fee_status_recalculated']).toBe(2);
  expect(dry['users.no_profile.teacher (review only)']).toBe(1);
  expect((await db.collection('students').findOne({ _id: billed })).feeStatus).toBe('Paid');

  await migrate({ apply: true, quiet: true });
  expect((await db.collection('students').findOne({ _id: billed })).feeStatus).toBe('Partial');
  expect((await db.collection('students').findOne({ _id: unbilled })).feeStatus).toBe('Not billed');
  expect(await db.collection('users').countDocuments({ _id: orphanUser })).toBe(1);
  expect((await migrate({ apply: false, quiet: true }))['students.fee_status_recalculated']).toBeUndefined();
});

test('links old marks and results to their scheduled exam and sets exam types and terms', async () => {
  const db = mongoose.connection.db;
  const school = oid();
  const examId = oid();
  const student = oid();
  await db.collection('examschedules').insertOne({ _id: examId, school, title: 'Mid Term', examType: 'Final', subject: 'Mathematics', class: '10', section: '', date: new Date('2026-09-20T00:00:00Z'), academicYear: '2026-27' });
  await db.collection('marks').insertOne({ school, student, class: '10', section: 'A', subject: 'mathematics', examName: 'Mid Term', examType: 'Final', maxMarks: 50, marksObtained: 40, academicYear: '2026-27', status: 'published' });
  await db.collection('examresults').insertMany([
    { school, student, class: '10', section: 'A', subject: 'Mathematics', examName: 'Mid Term', totalMarks: 50, marksObtained: 40, academicYear: '2026-27' },
    { school, student, class: '10', section: 'A', subject: 'Science', examName: 'Old Test', totalMarks: 50, marksObtained: 30, academicYear: '2026-27' },
  ]);

  const dry = await migrate({ apply: false, quiet: true });
  expect(dry['exams.type_or_term_set']).toBe(1);
  expect(dry['marks.linked_to_exam']).toBe(1);
  expect(dry['examResults.no_matching_exam (kept, shown without a term)']).toBe(1);

  await migrate({ apply: true, quiet: true });
  expect(await db.collection('examschedules').findOne({ _id: examId })).toMatchObject({ examType: 'Final Exam', term: 'Term 1' });
  expect(await db.collection('marks').findOne({ student })).toMatchObject({ exam: examId, term: 'Term 1', examType: 'Final Exam' });
  expect(await db.collection('examresults').findOne({ subject: 'Mathematics' })).toMatchObject({ exam: examId, term: 'Term 1' });
  expect(await db.collection('examresults').countDocuments()).toBe(2);
});
