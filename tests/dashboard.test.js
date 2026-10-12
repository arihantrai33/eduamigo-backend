const { api, connect, disconnect, clear, auth, seedSchool, makeUser } = require('./helpers');
const School = require('../src/models/School');
const Student = require('../src/models/Student');
const Fee = require('../src/models/Fee');
const Attendance = require('../src/models/Attendance');
const LeaveRequest = require('../src/models/LeaveRequest');
const Transport = require('../src/models/Transport');
const { clearPlanCache } = require('../src/services/subscription');
const { toDayKey } = require('../src/utils/dates');

let A;
let B;

beforeAll(connect);
afterAll(disconnect);
beforeEach(async () => {
  await clear();
  clearPlanCache();
  A = await seedSchool('Alpha School');
  B = await seedSchool('Beta School');
  const today = toDayKey(new Date());
  await Fee.create([
    { school: A.school._id, studentId: A.student._id, feeType: 'Tuition', amount: 1000, paidAmount: 400, dueDate: today },
    { school: A.school._id, studentId: A.otherStudent._id, feeType: 'Tuition', amount: 500, paidAmount: 500, status: 'Paid', dueDate: today },
    { school: B.school._id, studentId: B.student._id, feeType: 'Tuition', amount: 99999, dueDate: today },
  ]);
  await Attendance.create([
    { school: A.school._id, studentId: A.student._id, date: today, status: 'Present', class: '10', section: 'A' },
    { school: A.school._id, studentId: A.otherStudent._id, date: today, status: 'Absent', class: '10', section: 'B' },
    { school: B.school._id, studentId: B.student._id, date: today, status: 'Absent', class: '10', section: 'A' },
  ]);
  await LeaveRequest.create({ school: A.school._id, requestedBy: A.parentUser._id, role: 'parent', fromDate: today, toDate: today, reason: 'x' });
  await LeaveRequest.create({ school: B.school._id, requestedBy: B.parentUser._id, role: 'parent', fromDate: today, toDate: today, reason: 'x' });
  await Transport.create({ school: A.school._id, busNumber: 'B1', driverName: 'D', driverPhone: '9', routeName: 'R', driverToken: 'tok-a-1' });
});

const dashboard = (user) => api().get('/api/schools/me/dashboard').set(auth(user));

test('an admin gets every section, counted only from their own school', async () => {
  const res = await dashboard(A.admin);
  expect(res.status).toBe(200);
  const d = res.body.data;
  expect(d.counts).toEqual({ students: 2, teachers: 1, parents: 1, buses: 1 });
  expect(d.fees).toEqual({ billed: 1500, collected: 900, due: 600, records: 2 });
  expect(d.attendance).toMatchObject({ marked: 2, totalStudents: 2, notMarked: 0, present: 1, absent: 1, percentage: 50 });
  expect(d.pendingLeaves).toBe(1);
  expect(d.classes.map((c) => `${c.class}-${c.section}:${c.count}`).sort()).toEqual(['10-A:1', '10-B:1']);
  expect(d.recentStudents).toHaveLength(2);
  expect(JSON.stringify(d)).not.toContain(String(B.student._id));
});

test('recent activity comes from the audit log of this school only', async () => {
  await api().post('/api/announcements').set(auth(A.admin)).send({ title: 'Hello', message: 'Hi', targetRole: 'all' });
  await api().post('/api/announcements').set(auth(B.admin)).send({ title: 'Other', message: 'Hi', targetRole: 'all' });
  await new Promise((r) => setTimeout(r, 50)); // the audit entry is written after the response
  const d = (await dashboard(A.admin)).body.data;
  expect(d.activity).toEqual([expect.objectContaining({ action: 'announcement.posted', by: A.admin.name, at: expect.any(String) })]);
});

test('an accountant sees fees and students, not leaves, attendance, buses or the activity log', async () => {
  const accountant = await makeUser(A.school, 'accountant');
  const d = (await dashboard(accountant)).body.data;
  expect(d.fees.billed).toBe(1500);
  expect(d.counts.students).toBe(2);
  expect(d.counts.teachers).toBeUndefined();
  for (const key of ['pendingLeaves', 'attendance', 'activity']) expect(d[key]).toBeUndefined();
  expect(d.counts.buses).toBeUndefined();
});

test('modules outside the plan are left out', async () => {
  await School.updateOne({ _id: A.school._id }, { $set: { 'subscription.plan': 'basic' } });
  clearPlanCache();
  const d = (await dashboard(A.admin)).body.data;
  expect(d.counts.buses).toBeUndefined();
  expect(d.fees).toBeUndefined();
});

test('students and parents get no school-wide numbers', async () => {
  for (const user of [A.studentUser, A.parentUser]) {
    const d = (await dashboard(user)).body.data;
    expect(Object.keys(d)).toEqual(['date']);
  }
});

test('inactive students are not counted', async () => {
  await Student.updateOne({ _id: A.otherStudent._id }, { isActive: false });
  const d = (await dashboard(A.admin)).body.data;
  expect(d.counts.students).toBe(1);
  expect(d.attendance.totalStudents).toBe(1);
});
