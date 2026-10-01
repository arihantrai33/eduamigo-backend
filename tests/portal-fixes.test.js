// Regression tests for bugs found in the full portal walkthrough.
const { api, connect, disconnect, clear, auth, seedSchool } = require('./helpers');
const Teacher = require('../src/models/Teacher');
const Timetable = require('../src/models/Timetable');
const Fee = require('../src/models/Fee');

let A;
let B;
beforeAll(connect);
afterAll(disconnect);
beforeEach(async () => {
  await clear();
  A = await seedSchool('Alpha School');
  B = await seedSchool('Beta School');
});

const period = (no, subject, teacher, startTime, endTime) => ({ no, subject, teacher, startTime, endTime });

describe('timetable', () => {
  beforeEach(async () => {
    await api().post('/api/timetable').set(auth(A.admin)).send({
      class: '10', section: 'A', day: 'Thursday',
      periods: [period(2, 'Mathematics', A.teacher._id, '08:45', '09:30'), period(1, 'English', null, '08:00', '08:45')],
    });
    await api().post('/api/timetable').set(auth(A.admin)).send({
      class: '10', section: 'B', day: 'Thursday', periods: [period(1, 'Mathematics', A.teacher._id, '08:00', '08:45')],
    });
  });

  test('student "today" accepts short day names and returns a time label', async () => {
    const res = await api().get('/api/timetable/my?day=Thu').set(auth(A.studentUser));
    expect(res.status).toBe(200);
    expect(res.body.data.map((p) => p.subject).sort()).toEqual(['English', 'Mathematics']);
    expect(res.body.data.find((p) => p.subject === 'English').time).toBe('08:00 - 08:45');
    const sunday = await api().get('/api/timetable/my?day=Sunday').set(auth(A.studentUser));
    expect(sunday.body.data).toEqual([]);
  });

  test('teacher timetable has one entry per day with every class, in time order, labelled with the class', async () => {
    const res = await api().get(`/api/timetable/teacher/${A.teacher._id}`).set(auth(A.teacherUser));
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    const [thu] = res.body.data;
    expect(thu.day).toBe('Thursday');
    expect(thu.periods.map((p) => `${p.class}-${p.section} ${p.startTime}`)).toEqual(['10-B 08:00', '10-A 08:45']);
  });

  test('stored periods get a derived time label', async () => {
    const t = await Timetable.findOne({ school: A.school._id, section: 'A' });
    expect(t.periods.find((p) => p.subject === 'Mathematics').time).toBe('08:45 - 09:30');
  });
});

describe('parent home', () => {
  test('my-child includes each child\'s fee status', async () => {
    const res = await api().get('/api/parents/my-child').set(auth(A.parentUser));
    expect(res.body.data.children[0].feeStatus).toBe('Not billed');
  });

  test('asking for a child that is not yours is a 404, not an empty list', async () => {
    const res = await api().get(`/api/fees/my?studentId=${B.student._id}`).set(auth(A.parentUser));
    expect(res.status).toBe(404);
    await Fee.create({ school: A.school._id, studentId: A.student._id, feeType: 'Tuition', amount: 100, dueDate: new Date() });
    const mine = await api().get(`/api/fees/my?studentId=${A.student._id}`).set(auth(A.parentUser));
    expect(mine.body.data).toHaveLength(1);
  });
});

describe('payroll', () => {
  test('salary generation skips teachers with no salary and says so', async () => {
    await Teacher.create({ name: 'No Pay Set', email: 'nopay@a.test', phone: '9000000099', employeeId: 'E-NP', school: A.school._id });
    const res = await api().post('/api/hr/salaries/generate').set(auth(A.admin)).send({ month: 10, year: 2026 });
    expect(res.status).toBe(200);
    expect(res.body.data).toBe(1);
    expect(res.body.skipped.map((t) => t.name)).toEqual(['No Pay Set']);
    expect(res.body.message).toMatch(/Skipped 1/);
    const list = await api().get('/api/hr/salaries?month=10&year=2026').set(auth(A.admin));
    expect(list.body.data.every((s) => s.netSalary > 0)).toBe(true);
  });
});
