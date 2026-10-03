const { api, connect, disconnect, clear, auth, seedSchool, makeUser } = require('./helpers');
const Student = require('../src/models/Student');
const User = require('../src/models/User');
const Parent = require('../src/models/Parent');

let A;
let B;
beforeAll(connect);
afterAll(disconnect);
beforeEach(async () => {
  await clear();
  A = await seedSchool('Alpha School');
  B = await seedSchool('Beta School');
});

const enquiry = (extra = {}) => ({
  studentName: 'Meher Kapoor', classApplied: 'Class 10', parentName: 'Ritu Kapoor', parentPhone: '98765 43210',
  parentEmail: 'ritu.kapoor@x.test', source: 'Website', gender: 'Female', dateOfBirth: '2011-06-05', ...extra,
});
const move = (id, status, extra = {}) => api().patch(`/api/admissions/${id}/status`).set(auth(A.admin)).send({ status, ...extra });

test('enquiry to admission: numbers, history, student and logins created', async () => {
  const first = await api().post('/api/admissions').set(auth(A.admin)).send(enquiry()).expect(201);
  const second = await api().post('/api/admissions').set(auth(A.admin)).send(enquiry({ studentName: 'Arjun' })).expect(201);
  expect(first.body.data).toMatchObject({ status: 'Enquiry', classApplied: '10', parentPhone: '9876543210' });
  expect(first.body.data.applicationNo).toMatch(/^ADM-\d{4}-0001$/);
  expect(second.body.data.applicationNo).toMatch(/-0002$/);

  const id = first.body.data._id;
  await move(id, 'Applied').expect(200);
  await move(id, 'Test Scheduled').expect(400); // test date required
  await move(id, 'Test Scheduled', { testDate: '2026-11-10' }).expect(200);
  await move(id, 'Approved', { note: 'Cleared the entrance test' }).expect(200);
  await api().post(`/api/admissions/${id}/admit`).set(auth(A.admin)).send({ section: 'A', studentEmail: 'not-an-email' }).expect(400);

  const defaults = await api().get(`/api/admissions/${id}/admit-defaults?section=A`).set(auth(A.admin)).expect(200);
  expect(defaults.body.data.rollNumber).toBe('2'); // seeded Aarav has roll 1 in 10-A

  const admit = await api().post(`/api/admissions/${id}/admit`).set(auth(A.admin)).send({ section: 'A', studentEmail: 'meher@alpha.test' }).expect(201);
  expect(admit.body.data.status).toBe('Admitted');
  expect(admit.body.credentials.student.email).toBe('meher@alpha.test');
  expect(admit.body.credentials.parent.email).toBe('ritu.kapoor@x.test');
  const student = await Student.findById(admit.body.student._id);
  expect(student).toMatchObject({ name: 'Meher Kapoor', class: '10', section: 'A', rollNumber: '2', parentName: 'Ritu Kapoor' });
  expect(admit.body.data.history.map((h) => h.status)).toEqual(['Enquiry', 'Applied', 'Test Scheduled', 'Approved', 'Admitted']);

  await api().post(`/api/admissions/${id}/admit`).set(auth(A.admin)).send({ section: 'A', studentEmail: 'x@alpha.test' }).expect(409);
  await api().put(`/api/admissions/${id}`).set(auth(A.admin)).send({ studentName: 'Changed' }).expect(409);

  const list = await api().get('/api/admissions').set(auth(A.admin));
  expect(list.body.counts).toMatchObject({ Enquiry: 1, Admitted: 1 });
});

test('status rules: no skipping steps, admitted only through admit, closed applications can reopen', async () => {
  const { body } = await api().post('/api/admissions').set(auth(A.admin)).send(enquiry()).expect(201);
  const id = body.data._id;
  await move(id, 'Approved').expect(400);
  await move(id, 'Admitted').expect(400);
  await api().post(`/api/admissions/${id}/admit`).set(auth(A.admin)).send({ section: 'A', studentEmail: 'm@a.test' }).expect(400);
  await move(id, 'Withdrawn', { note: 'Family relocated' }).expect(200);
  await move(id, 'Enquiry').expect(200);
});

test('a sibling is linked to the existing parent login instead of a new one', async () => {
  const { body } = await api().post('/api/admissions').set(auth(A.admin)).send(enquiry({ parentEmail: A.parentUser.email })).expect(201);
  await move(body.data._id, 'Applied');
  await move(body.data._id, 'Approved');
  const admit = await api().post(`/api/admissions/${body.data._id}/admit`).set(auth(A.admin)).send({ section: 'B', studentEmail: 'sib@alpha.test' }).expect(201);
  expect(admit.body.linkedExistingParent).toBe(true);
  expect(admit.body.credentials.parent).toBeUndefined();
  const parent = await Parent.findOne({ userId: A.parentUser._id });
  expect(parent.children.map(String)).toContain(String(admit.body.student._id));
});

test('a failed admission (duplicate login email) can be retried and creates nothing', async () => {
  const { body } = await api().post('/api/admissions').set(auth(A.admin)).send(enquiry()).expect(201);
  await move(body.data._id, 'Applied');
  await move(body.data._id, 'Approved');
  const users = await User.countDocuments();
  await api().post(`/api/admissions/${body.data._id}/admit`).set(auth(A.admin)).send({ section: 'A', studentEmail: A.studentUser.email }).expect(409);
  expect(await User.countDocuments()).toBe(users);
  await api().post(`/api/admissions/${body.data._id}/admit`).set(auth(A.admin)).send({ section: 'A', studentEmail: 'new@alpha.test' }).expect(201);
});

test('access: admins only, and only their own school', async () => {
  const { body } = await api().post('/api/admissions').set(auth(A.admin)).send(enquiry()).expect(201);
  await api().get('/api/admissions').set(auth(A.teacherUser)).expect(403);
  await api().get('/api/admissions').set(auth(A.parentUser)).expect(403);
  const accountant = await makeUser(A.school, 'accountant');
  await api().get('/api/admissions').set(auth(accountant)).expect(403);
  await api().patch(`/api/admissions/${body.data._id}/status`).set(auth(B.admin)).send({ status: 'Applied' }).expect(404);
  const other = await api().get('/api/admissions').set(auth(B.admin));
  expect(other.body.data).toHaveLength(0);
});

test('validation: required fields and phone format', async () => {
  await api().post('/api/admissions').set(auth(A.admin)).send({ studentName: 'X' }).expect(400);
  await api().post('/api/admissions').set(auth(A.admin)).send(enquiry({ parentPhone: '12345' })).expect(400);
  await api().post('/api/admissions').set(auth(A.admin)).send(enquiry({ source: 'Billboard' })).expect(400);
});
