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
