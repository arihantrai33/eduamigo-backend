const { api, connect, disconnect, clear, auth, seedSchool } = require('./helpers');
const Student = require('../src/models/Student');
const User = require('../src/models/User');
const StudentEnrollment = require('../src/models/StudentEnrollment');
const AcademicSession = require('../src/models/AcademicSession');

let A;
let B;
let zoya;
let bhavya;

beforeAll(connect);
afterAll(disconnect);
beforeEach(async () => {
  await clear();
  A = await seedSchool('Alpha School'); // Aarav in 10-A (with a parent), Diya in 10-B
  B = await seedSchool('Beta School');
  const admin = auth(A.admin);
  await api().post('/api/academic/sessions').set(admin).send({ name: '2026-27' }).expect(201);
  await api().post('/api/academic/sessions').set(admin).send({ name: '2027-28' }).expect(201);
  await api().post('/api/academic/classes').set(admin).send({ name: '9', sections: ['A'] }).expect(201);
  await api().post('/api/academic/classes').set(admin).send({ name: '10', sections: ['A', 'B'] }).expect(201);
  const add = (name) => api().post('/api/students').set(admin).send({ name, phone: '9000000099', class: '9', section: 'A' });
  zoya = (await add('Zoya')).body.data;
  bhavya = (await add('Bhavya')).body.data;
});

const preview = () => api().get('/api/academic/year-end?toSession=2027-28').set(auth(A.admin));

test('preview suggests the next class, and passing out for the last class', async () => {
  const res = await preview();
  expect(res.status).toBe(200);
  const byName = Object.fromEntries(res.body.data.students.map((r) => [r.student.name, r.suggestion]));
  expect(byName.Zoya).toEqual({ action: 'promote', toClass: '10', toSection: 'A' });
  expect(byName.Aarav).toEqual({ action: 'graduate' });
  expect(res.body.data.counts).toEqual({ promote: 2, graduate: 2 });
  expect((await api().get('/api/academic/year-end?toSession=2099-00').set(auth(A.admin))).status).toBe(400);
  expect((await preview().set(auth(A.teacherUser))).status).toBe(403);
});

test('apply: promote, detain, leave and pass out; new roll numbers; history kept; safe to run twice', async () => {
  const res = await api().post('/api/academic/year-end').set(auth(A.admin)).send({
    toSession: '2027-28', makeCurrent: true,
    decisions: [
      { studentId: zoya._id, action: 'detain' },
      { studentId: A.otherStudent._id, action: 'leave', reason: 'Family moved to Delhi' },
    ],
  });
  expect({ status: res.status, message: res.body.message }).toMatchObject({ status: 200 });
  expect(res.body.data).toMatchObject({ promote: 1, detain: 1, leave: 1, graduate: 1, skipped: 0 });

  const b = await Student.findById(bhavya._id);
  expect(b).toMatchObject({ class: '10', section: 'A', rollNumber: '1' });
  const z = await Student.findById(zoya._id);
  expect(z).toMatchObject({ class: '9', section: 'A', rollNumber: '1', isActive: true });

  const aarav = await Student.findById(A.student._id);
  expect(aarav.isActive).toBe(false);
  expect(aarav.exit).toMatchObject({ status: 'graduated', lastClass: '10-A' });
  expect((await User.findById(A.studentUser._id)).isActive).toBe(false);
  expect((await User.findById(A.parentUser._id)).isActive).toBe(false); // no other child in the school
  const diya = await Student.findById(A.otherStudent._id);
  expect(diya.exit).toMatchObject({ status: 'left', reason: 'Family moved to Delhi', lastClass: '10-B' });

  const history = await StudentEnrollment.find({ student: bhavya._id }).sort({ session: 1 }).lean();
  expect(history.map((h) => [h.session, h.class, h.status])).toEqual([['2026-27', '9', 'promoted'], ['2027-28', '10', 'studying']]);
  const zh = await StudentEnrollment.find({ student: zoya._id }).sort({ session: 1 }).lean();
  expect(zh.map((h) => [h.session, h.status])).toEqual([['2026-27', 'detained'], ['2027-28', 'studying']]);
  expect((await AcademicSession.findOne({ school: A.school._id, status: 'current' })).name).toBe('2027-28');

  const again = await api().post('/api/academic/year-end').set(auth(A.admin)).send({ toSession: '2027-28' });
  expect(again.body.data).toMatchObject({ promote: 0, detain: 0, skipped: 2 });
  expect(await Student.findById(bhavya._id)).toMatchObject({ class: '10', section: 'A' });
});

test('one bad decision changes nothing', async () => {
  const bad = await api().post('/api/academic/year-end').set(auth(A.admin)).send({
    toSession: '2027-28',
    decisions: [{ studentId: bhavya._id, action: 'promote', toClass: '11', toSection: 'A' }], // no class 11
  });
  expect(bad.status).toBe(400);
  const other = await api().post('/api/academic/year-end').set(auth(A.admin)).send({
    toSession: '2027-28', decisions: [{ studentId: B.student._id, action: 'leave' }], // another school's student
  });
  expect(other.status).toBe(400);
  expect(await Student.findById(A.student._id)).toMatchObject({ isActive: true, class: '10' });
  expect(await StudentEnrollment.countDocuments({ school: A.school._id, session: '2027-28' })).toBe(0);
});

test('transfer certificate: only after leaving, one number per student, staff only', async () => {
  expect((await api().get(`/api/students/${A.student._id}/transfer-certificate`).set(auth(A.admin))).status).toBe(409);
  await api().delete(`/api/students/${A.student._id}`).set(auth(A.admin)).send({ reason: 'Admission elsewhere' }).expect(200);

  const tc = await api().get(`/api/students/${A.student._id}/transfer-certificate`).set(auth(A.admin));
  expect(tc.status).toBe(200);
  expect(tc.body.data.tcNumber).toMatch(/^TC\/\d{4}\/0001$/);
  expect(tc.body.data.student).toMatchObject({ name: 'Aarav', lastClass: '10-A', reason: 'Admission elsewhere', status: 'left' });
  expect(tc.body.data.school.name).toBe('Alpha School');
  const again = await api().get(`/api/students/${A.student._id}/transfer-certificate`).set(auth(A.admin));
  expect(again.body.data.tcNumber).toBe(tc.body.data.tcNumber);

  expect((await api().get(`/api/students/${A.student._id}/transfer-certificate`).set(auth(A.teacherUser))).status).toBe(403);
  expect((await api().get(`/api/students/${A.student._id}/transfer-certificate`).set(auth(B.admin))).status).toBe(404);
});

test('a roll number freed by a student who left can be given to a new admission', async () => {
  await api().delete(`/api/students/${bhavya._id}`).set(auth(A.admin)).expect(200); // Bhavya had roll 2 in 9-A
  const next = await api().post('/api/students').set(auth(A.admin)).send({ name: 'Kiran', phone: '9000000098', class: '9', section: 'A' });
  expect({ status: next.status, message: next.body.message }).toEqual({ status: 201, message: undefined });
  expect(next.body.data.rollNumber).toBe('2');
  const clash = await api().post('/api/students').set(auth(A.admin)).send({ name: 'Ira', phone: '9000000097', class: '9', section: 'A', rollNumber: '1' });
  expect(clash.status).toBe(409); // Zoya still has roll 1
});
