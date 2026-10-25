// Homework: a teacher gives it to a class, to chosen students or to one student; students and parents see only theirs.
process.env.PHOTO_STORAGE = 'local';
process.env.PHOTO_LOCAL_DIR = require('path').join(require('os').tmpdir(), `eduamigo-homework-${process.pid}`);

const { api, connect, disconnect, clear, auth, seedSchool, makeUser } = require('./helpers');
const Student = require('../src/models/Student');
const Notification = require('../src/models/Notification');
const Homework = require('../src/models/Homework');

const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(80, 1)]);
const ymd = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
const settle = () => new Promise((r) => setTimeout(r, 120));

let A; let B; let second; // second: another student of 10-A
beforeAll(connect);
afterAll(disconnect);
beforeEach(async () => {
  await clear();
  A = await seedSchool('Alpha School');
  B = await seedSchool('Beta School');
  const u = await makeUser(A.school, 'student');
  second = await Student.create({ name: 'Kabir', email: u.email, phone: '9000000008', rollNumber: '2', class: '10', section: 'A', school: A.school._id, userId: u._id });
});

const give = (user, fields = {}, file) => {
  let req = api().post('/api/homework').set(auth(user));
  const body = { title: 'Fractions worksheet', subject: 'Mathematics', class: '10', section: 'A', dueDate: ymd(2), description: 'Do all questions', ...fields };
  for (const [k, v] of Object.entries(body)) req = req.field(k, typeof v === 'string' ? v : JSON.stringify(v));
  return file ? req.attach('files', file, { filename: 'sheet.pdf', contentType: 'application/pdf' }) : req;
};

describe('giving homework', () => {
  test('a teacher gives homework to the whole class: its students and their parent are told, the file opens', async () => {
    const res = await give(A.teacherUser, {}, PDF);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ title: 'Fractions worksheet', class: '10', section: 'A', audience: 'class', assigned: 2, done: 0 });
    expect(res.body.data.attachments[0]).toMatchObject({ name: 'sheet.pdf', type: 'application/pdf', kind: 'pdf' });
    expect(JSON.stringify(res.body)).not.toMatch(/eduamigo\/|"key"/);
    await settle();
    expect(await Notification.countDocuments({ recipient: A.studentUser._id, type: 'Homework' })).toBe(1);
    expect(await Notification.countDocuments({ recipient: A.parentUser._id, type: 'Homework' })).toBe(1);
    const file = await api().get(res.body.data.attachments[0].url.replace(/^https?:\/\/[^/]+/, ''));
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toMatch(/application\/pdf/);
  });

  test('homework for chosen students reaches only them; one student works too', async () => {
    const some = await give(A.teacherUser, { audience: 'students', studentIds: [String(A.student._id)] });
    expect(some.status).toBe(201);
    expect(some.body.data).toMatchObject({ audience: 'students', assigned: 1 });
    const mine = await api().get('/api/homework/my').set(auth(A.studentUser));
    const theirs = await api().get('/api/homework/my').set(auth((await require('../src/models/User').findById(second.userId))));
    expect(mine.body.data).toHaveLength(1);
    expect(theirs.body.data).toHaveLength(0);
  });

  test('students who are not in the class, an empty choice, a past date and a class the teacher does not teach are refused', async () => {
    expect((await give(A.teacherUser, { audience: 'students', studentIds: [String(A.otherStudent._id)] })).status).toBe(400); // 10-B student, class 10-A
    expect((await give(A.teacherUser, { audience: 'students', studentIds: [] })).status).toBe(400);
    expect((await give(A.teacherUser, { dueDate: ymd(-3) })).status).toBe(400);
    expect((await give(A.teacherUser, { class: '9', section: 'C' })).status).toBe(403);
    expect((await give(A.teacherUser, { title: '' })).status).toBe(400);
  });

  test('an unsafe or unknown file is refused, and students and parents cannot give homework', async () => {
    const bad = await give(A.teacherUser, {}, Buffer.from('<html><script>alert(1)</script></html>'));
    expect(bad.status).toBe(400);
    expect((await give(A.studentUser)).status).toBe(403);
    expect((await give(A.parentUser)).status).toBe(403);
    expect(await Homework.countDocuments()).toBe(0);
  });
});

describe('seeing and finishing homework', () => {
  test('a student sees class homework, marks it done and undone; a parent sees the child\'s status', async () => {
    const hw = (await give(A.teacherUser)).body.data;
    let list = await api().get('/api/homework/my').set(auth(A.studentUser));
    expect(list.body.data[0]).toMatchObject({ _id: hw._id, done: false, overdue: false });
    expect((await api().post(`/api/homework/${hw._id}/done`).set(auth(A.studentUser))).status).toBe(200);
    list = await api().get('/api/homework/my').set(auth(A.studentUser));
    expect(list.body.data[0].done).toBe(true);
    const parent = await api().get('/api/homework/child').set(auth(A.parentUser));
    expect(parent.body.data[0]).toMatchObject({ _id: hw._id, done: true });
    expect((await api().delete(`/api/homework/${hw._id}/done`).set(auth(A.studentUser))).status).toBe(200);
    expect((await api().get('/api/homework/my').set(auth(A.studentUser))).body.data[0].done).toBe(false);
  });

  test('another section, another class and another school never see it', async () => {
    const hw = (await give(A.teacherUser)).body.data;
    expect((await api().get('/api/homework/my').set(auth(A.otherStudentUser))).body.data).toHaveLength(0);          // 10-B
    expect((await api().get('/api/homework/my').set(auth(B.studentUser))).body.data).toHaveLength(0);                // other school
    expect((await api().post(`/api/homework/${hw._id}/done`).set(auth(A.otherStudentUser))).status).toBe(404);
    expect((await api().get(`/api/homework/${hw._id}`).set(auth(B.admin))).status).toBe(404);
  });

  test('the teacher sees how many have finished and who; another teacher\'s homework is hidden, the office sees all', async () => {
    const hw = (await give(A.teacherUser)).body.data;
    await api().post(`/api/homework/${hw._id}/done`).set(auth(A.studentUser));
    const d = await api().get(`/api/homework/${hw._id}`).set(auth(A.teacherUser));
    expect(d.body.data).toMatchObject({ assigned: 2, done: 1 });
    expect(d.body.data.students.find((s) => s.name === 'Aarav').done).toBe(true);
    const list = await api().get('/api/homework').set(auth(A.teacherUser));
    expect(list.body.data[0]).toMatchObject({ assigned: 2, done: 1 });
    const other = await makeUser(A.school, 'teacher');
    await require('../src/models/Teacher').create({ name: other.name, email: other.email, phone: '9000000099', employeeId: 'E99', subjects: ['Science'], assignedClasses: ['10-A'], school: A.school._id, userId: other._id, salary: 1 });
    expect((await api().get('/api/homework').set(auth(other))).body.data).toHaveLength(0);
    expect((await api().get(`/api/homework/${hw._id}`).set(auth(other))).status).toBe(404);
    expect((await api().get('/api/homework').set(auth(A.admin))).body.data).toHaveLength(1);
  });

  test('removing homework removes its file and its finished marks', async () => {
    const hw = (await give(A.teacherUser, {}, PDF)).body.data;
    await api().post(`/api/homework/${hw._id}/done`).set(auth(A.studentUser));
    const link = hw.attachments[0].url.replace(/^https?:\/\/[^/]+/, '');
    expect((await api().delete(`/api/homework/${hw._id}`).set(auth(A.teacherUser))).status).toBe(200);
    expect(await Homework.countDocuments()).toBe(0);
    expect(await require('../src/models/HomeworkDone').countDocuments()).toBe(0);
    expect((await api().get(link)).status).toBe(404);
  });
});

describe('files', () => {
  test('a link that was changed, or a made-up one, opens nothing', async () => {
    const hw = (await give(A.teacherUser, {}, PDF)).body.data;
    const link = hw.attachments[0].url.replace(/^https?:\/\/[^/]+/, '');
    expect((await api().get(`${link}x`)).status).toBe(404);
    expect((await api().get('/api/files/nonsense')).status).toBe(404);
  });
});
