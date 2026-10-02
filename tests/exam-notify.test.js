const { api, connect, disconnect, clear, auth, seedSchool } = require('./helpers');
const Notification = require('../src/models/Notification');

let A;
let B;
beforeAll(connect);
afterAll(disconnect);
beforeEach(async () => {
  await clear();
  A = await seedSchool('Alpha School');
  B = await seedSchool('Beta School');
});

const inDays = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
const exam = (over = {}) => ({
  title: 'Science Mid Term', examType: 'Mid Term', subject: 'Science', class: '10', section: 'A',
  date: inDays(5), startTime: '10:00', endTime: '12:30', totalMarks: 100, venue: 'Room C5', ...over,
});
const notesFor = (user) => Notification.find({ recipient: user._id }).sort({ createdAt: 1 }).lean();

test('scheduling an exam notifies the class students and their parents, not other schools', async () => {
  const res = await api().post('/api/exams').set(auth(A.admin)).send(exam());
  expect(res.status).toBe(201);
  const [s] = await notesFor(A.studentUser);
  const [p] = await notesFor(A.parentUser);
  expect(s).toMatchObject({ title: 'Exam scheduled: Science', type: 'Exam' });
  expect(s.message).toMatch(/Science Mid Term .*Class 10-A.*10:00–12:30, Room C5/);
  expect(p.title).toBe('Exam scheduled: Science');
  expect(await notesFor(A.otherStudentUser)).toHaveLength(0); // section B
  expect(await notesFor(B.studentUser)).toHaveLength(0);
  expect(await notesFor(B.parentUser)).toHaveLength(0);
});

test('students see upcoming exams of their own class only', async () => {
  await api().post('/api/exams').set(auth(A.admin)).send(exam()).expect(201);
  await api().post('/api/exams').set(auth(A.admin)).send(exam({ class: '9', title: 'Other class' })).expect(201);
  const res = await api().get('/api/exams').set(auth(A.studentUser));
  expect(res.body.data.map((e) => e.title)).toEqual(['Science Mid Term']);
});

test('end time must be after the start time, and times must be valid', async () => {
  const bad = await api().post('/api/exams').set(auth(A.admin)).send(exam({ startTime: '10:00', endTime: '10:00' }));
  expect(bad.status).toBe(400);
  expect(bad.body.message).toBe('End time must be after the start time');
  const garbage = await api().post('/api/exams').set(auth(A.admin)).send(exam({ startTime: '25:00' }));
  expect(garbage.status).toBe(400);
  const created = (await api().post('/api/exams').set(auth(A.admin)).send(exam()).expect(201)).body.data;
  const edit = await api().put(`/api/exams/${created._id}`).set(auth(A.admin)).send({ endTime: '09:00' });
  expect(edit.status).toBe(400);
});

test('moving or cancelling an exam notifies again; editing only the instructions does not', async () => {
  const created = (await api().post('/api/exams').set(auth(A.admin)).send(exam()).expect(201)).body.data;
  await api().put(`/api/exams/${created._id}`).set(auth(A.admin)).send({ instructions: 'Bring a pen' }).expect(200);
  expect(await notesFor(A.studentUser)).toHaveLength(1);
  await api().put(`/api/exams/${created._id}`).set(auth(A.admin)).send({ date: inDays(7) }).expect(200);
  await api().delete(`/api/exams/${created._id}`).set(auth(A.admin)).expect(200);
  const titles = (await notesFor(A.studentUser)).map((n) => n.title);
  expect(titles).toEqual(['Exam scheduled: Science', 'Exam updated: Science', 'Exam cancelled: Science']);
});

test('past-dated exams (entered for record keeping) are not announced', async () => {
  await api().post('/api/exams').set(auth(A.admin)).send(exam({ date: inDays(-10) })).expect(201);
  expect(await notesFor(A.studentUser)).toHaveLength(0);
});
