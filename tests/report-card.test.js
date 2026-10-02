const { api, connect, disconnect, clear, auth, seedSchool, scheduleExam } = require('./helpers');
const Student = require('../src/models/Student');
const Attendance = require('../src/models/Attendance');

let A;
let B;
let second;
beforeAll(connect);
afterAll(disconnect);

async function publish(exam, rows) {
  await api().post('/api/marks/save').set(auth(A.teacherUser)).send({ examId: String(exam._id), marksData: rows }).expect(200);
  await api().patch('/api/marks/publish').set(auth(A.teacherUser)).send({ examId: String(exam._id) }).expect(200);
}
const day = (s) => new Date(`${s}T00:00:00Z`);

beforeEach(async () => {
  await clear();
  A = await seedSchool('Alpha School');
  B = await seedSchool('Beta School');
  second = await Student.create({ name: 'Zoya', email: 'zoya@a.test', phone: '9000000077', rollNumber: '2', class: '10', section: 'A', school: A.school._id });
  A.teacher.subjects = ['Mathematics', 'Science'];
  await A.teacher.save();
  const ut1 = await scheduleExam(A, { title: 'Unit Test 1', examType: 'Unit Test', totalMarks: 50, date: day('2026-07-10'), term: 'Term 1' });
  const mid = await scheduleExam(A, { title: 'Half Yearly', examType: 'Half Yearly', totalMarks: 100, date: day('2026-09-15'), term: 'Term 1' });
  const sci = await scheduleExam(A, { title: 'Half Yearly', examType: 'Half Yearly', subject: 'Science', totalMarks: 100, date: day('2026-09-16'), term: 'Term 1' });
  const t2 = await scheduleExam(A, { title: 'Unit Test 2', examType: 'Unit Test', totalMarks: 50, date: day('2026-09-28'), term: 'Term 2' });
  const aarav = String(A.student._id);
  const zoya = String(second._id);
  await publish(ut1, [{ studentId: aarav, marksObtained: 40 }, { studentId: zoya, marksObtained: 45 }]);
  await publish(mid, [{ studentId: aarav, marksObtained: 80 }, { studentId: zoya, marksObtained: 20 }]);
  await publish(sci, [{ studentId: aarav, absent: true }, { studentId: zoya, marksObtained: 70 }]);
  await publish(t2, [{ studentId: aarav, marksObtained: 25 }, { studentId: zoya, marksObtained: 30 }]);
  await Attendance.create([
    { school: A.school._id, studentId: A.student._id, class: '10', section: 'A', date: day('2026-07-01'), status: 'Present' },
    { school: A.school._id, studentId: A.student._id, class: '10', section: 'A', date: day('2026-07-02'), status: 'Absent' },
    { school: A.school._id, studentId: A.student._id, class: '10', section: 'A', date: day('2026-10-02'), status: 'Present' },
  ]);
});

test('term card: one column per exam in the term, subject totals, grades, attendance and rank', async () => {
  const res = await api().get(`/api/report-cards/student/${A.student._id}?term=Term 1&academicYear=2026-27`).set(auth(A.parentUser));
  expect(res.status).toBe(200);
  const { school, cards } = res.body.data;
  expect(school.name).toBe('Alpha School');
  const [card] = cards;
  expect(card.columns.map((c) => c.label)).toEqual(['Unit Test 1', 'Half Yearly']);
  const maths = card.subjects.find((s) => s.subject === 'Mathematics');
  expect(maths).toMatchObject({ obtained: 120, max: 150, percentage: 80, grade: 'A' });
  expect(maths.cells['Unit Test 1']).toMatchObject({ obtained: 40, max: 50 });
  const science = card.subjects.find((s) => s.subject === 'Science');
  expect(science.cells['Half Yearly']).toMatchObject({ absent: true, grade: 'AB' });
  expect(card.totals).toMatchObject({ obtained: 120, max: 250, percentage: 48, result: 'Below passing marks', belowIn: ['Science'] });
  expect(card.attendance).toEqual({ present: 1, workingDays: 2, percentage: 50 });
  expect(card.rank).toBe(2); // Zoya has 135/250 (54%)
  expect(card.classSize).toBe(2);
});

test('full-year card has one column per term', async () => {
  const res = await api().get('/api/report-cards/student/me?term=Full Year&academicYear=2026-27').set(auth(A.studentUser));
  expect(res.status).toBe(200);
  const [card] = res.body.data.cards;
  expect(card.columns.map((c) => c.key)).toEqual(['Term 1', 'Term 2']);
  const maths = card.subjects.find((s) => s.subject === 'Mathematics');
  expect(maths.cells['Term 1']).toMatchObject({ obtained: 120, max: 150 });
  expect(maths.cells['Term 2']).toMatchObject({ obtained: 25, max: 50 });
  expect(card.attendance.workingDays).toBe(3);
});

test('class report cards for the teacher of that class; teacher remarks are printed', async () => {
  await api().put(`/api/report-cards/student/${A.student._id}/remarks`).set(auth(A.teacherUser))
    .send({ term: 'Term 1', academicYear: '2026-27', remarks: 'Strong in algebra; needs regular revision in Science.' }).expect(200);
  const res = await api().get('/api/report-cards?class=10&section=A&term=Term 1&academicYear=2026-27').set(auth(A.teacherUser));
  expect(res.status).toBe(200);
  expect(res.body.data.cards.map((c) => c.student.name)).toEqual(['Aarav', 'Zoya']);
  expect(res.body.data.cards[0].remarks).toMatch(/Strong in algebra/);
});

test('access: other parents, other classes and other schools are refused', async () => {
  await api().get(`/api/report-cards/student/${second._id}?term=Term 1`).set(auth(A.parentUser)).expect(404);
  await api().get(`/api/report-cards/student/${A.student._id}?term=Term 1`).set(auth(B.admin)).expect(404);
  await api().get('/api/report-cards?class=10&section=B&term=Term 1').set(auth(A.teacherUser)).expect(403);
  await api().get('/api/report-cards?class=10&section=A&term=Term 1').set(auth(A.studentUser)).expect(403);
  await api().put(`/api/report-cards/student/${A.student._id}/remarks`).set(auth(A.parentUser)).send({ term: 'Term 1', remarks: 'x' }).expect(403);
  await api().get(`/api/report-cards/student/${A.student._id}?term=Term 3`).set(auth(A.admin)).expect(400);
  await api().get('/api/report-cards/student/me?term=Term 1').set(auth(A.parentUser)).expect(404);
});

test('unpublished marks never appear on a report card', async () => {
  const draft = await scheduleExam(A, { title: 'Weekly Quiz', examType: 'Quiz', totalMarks: 10, date: day('2026-08-01'), term: 'Term 1' });
  await api().post('/api/marks/save').set(auth(A.teacherUser)).send({ examId: String(draft._id), marksData: [{ studentId: String(A.student._id), marksObtained: 2 }] }).expect(200);
  const res = await api().get(`/api/report-cards/student/${A.student._id}?term=Term 1&academicYear=2026-27`).set(auth(A.admin));
  expect(res.body.data.cards[0].columns.map((c) => c.label)).not.toContain('Weekly Quiz');
});
