// Date of admission (Student.admittedOn): recorded only when known, never taken from createdAt; the transfer
// certificate says when it is missing; the migration fills it only from a real Admissions "Admitted" step.
const { api, connect, disconnect, clear, auth, seedSchool } = require('./helpers');
const Student = require('../src/models/Student');
const Admission = require('../src/models/Admission');
const { backfillAdmissionDates } = require('../src/services/admissionDate');
const { toDayKey, formatDay } = require('../src/utils/dates');

let A;
let B;
beforeAll(connect);
afterAll(disconnect);
beforeEach(async () => {
  await clear();
  A = await seedSchool('Alpha School');
  B = await seedSchool('Beta School');
});

const admin = () => auth(A.admin);
const add = (extra) => api().post('/api/students').set(admin()).send({ name: 'Kiran', phone: '9000000099', class: '10', section: 'A', ...extra });
const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : d);
const tcFor = async (id) => {
  await api().delete(`/api/students/${id}`).set(admin()).send({ reason: 'Moved to another city' }).expect(200);
  return api().get(`/api/students/${id}/transfer-certificate`).set(admin());
};

test('a new student keeps the admission date given, or none; bad dates are refused with a reason', async () => {
  const withDate = await add({ admittedOn: '2019-04-02', dateOfBirth: '2012-05-01' });
  expect(withDate.status).toBe(201);
  expect(day(withDate.body.data.admittedOn)).toBe('2019-04-02');

  const without = await add({ name: 'Ira', phone: '9000000098' });
  expect(without.status).toBe(201);
  expect(without.body.data.admittedOn).toBeNull(); // not the creation date

  const tomorrow = formatDay(new Date(toDayKey().getTime() + 86400000));
  for (const [value, message] of [
    [tomorrow, 'Date of admission cannot be in the future'],
    ['2026-02-30', 'Date of admission is not a valid date'],
    ['last year', 'Date of admission must be a date (YYYY-MM-DD)'],
  ]) {
    const res = await add({ name: 'X', phone: '9000000097', admittedOn: value });
    expect({ status: res.status, message: res.body.message }).toEqual({ status: 400, message });
  }
  const beforeBirth = await add({ name: 'Y', phone: '9000000096', dateOfBirth: '2015-01-10', admittedOn: '2014-06-01' });
  expect(beforeBirth.body.message).toBe('Date of admission cannot be before the date of birth');
});

test('the admission date can be recorded later, changed and cleared; it is checked against the date of birth', async () => {
  const id = A.student._id;
  await api().put(`/api/students/${id}`).set(admin()).send({ dateOfBirth: '2011-03-03' }).expect(200);
  const set = await api().put(`/api/students/${id}`).set(admin()).send({ admittedOn: '2016-04-01' });
  expect({ status: set.status, admitted: day(set.body.data.admittedOn) }).toEqual({ status: 200, admitted: '2016-04-01' });
  expect((await api().put(`/api/students/${id}`).set(admin()).send({ admittedOn: '2010-01-01' })).body.message)
    .toBe('Date of admission cannot be before the date of birth');
  // Moving the date of birth after the recorded admission date is refused too.
  expect((await api().put(`/api/students/${id}`).set(admin()).send({ dateOfBirth: '2017-01-01' })).status).toBe(400);
  const cleared = await api().put(`/api/students/${id}`).set(admin()).send({ admittedOn: '' });
  expect(cleared.body.data.admittedOn).toBeNull();
  // Teachers cannot change student records.
  expect((await api().put(`/api/students/${id}`).set(auth(A.teacherUser)).send({ admittedOn: '2016-04-01' })).status).toBe(403);
});

test('legacy record without the field: the transfer certificate says the date is not recorded, never the creation date', async () => {
  const { insertedId } = await Student.collection.insertOne({
    name: 'Old Record', phone: '9000000095', rollNumber: '7', class: '10', section: 'A', school: A.school._id, isActive: true,
    exit: { status: null }, createdAt: new Date('2025-01-15T10:00:00Z'), updatedAt: new Date('2025-01-15T10:00:00Z'),
  });
  const tc = await tcFor(insertedId);
  expect(tc.status).toBe(200);
  expect(tc.body.data.student.admittedOn).toBeNull();
  expect(tc.body.data.missing).toEqual(['admittedOn', 'dateOfBirth']);
  expect(JSON.stringify(tc.body.data)).not.toContain('2025-01-15');

  // Once the school records the real date, the certificate shows it.
  await api().put(`/api/students/${insertedId}`).set(admin()).send({ admittedOn: '2014-06-10', dateOfBirth: '2010-02-02' }).expect(200);
  const again = await api().get(`/api/students/${insertedId}/transfer-certificate`).set(admin());
  expect(day(again.body.data.student.admittedOn)).toBe('2014-06-10');
  expect(again.body.data.missing).toEqual([]);
});

test('imported students: a bulk upload sets the date only from its own column; a bad date fails that row', async () => {
  const res = await api().post('/api/bulk/upload/students').set(admin()).send({ students: [
    { name: 'From Sheet', phone: '9000000094', class: '10', section: 'A', admissionDate: '2018-04-05' },
    { name: 'No Date Column', phone: '9000000093', class: '10', section: 'A' },
    { name: 'Bad Date', phone: '9000000092', class: '10', section: 'A', admittedOn: '05/04/2018' },
  ] });
  expect(res.status).toBe(200);
  expect(res.body.data).toMatchObject({ success: 2, failed: 1 });
  expect(JSON.stringify(res.body.data.errors)).toContain('Date of admission must be a date (YYYY-MM-DD)');
  expect(day((await Student.findOne({ name: 'From Sheet' })).admittedOn)).toBe('2018-04-05');
  const imported = await Student.findOne({ name: 'No Date Column' });
  expect(imported.admittedOn).toBeNull();
  expect((await tcFor(imported._id)).body.data.missing).toContain('admittedOn');
});

test('admitting an Admissions application records that day as the date of admission', async () => {
  const app = await api().post('/api/admissions').set(admin()).send({ studentName: 'Meher', classApplied: '10', parentName: 'Ritu', parentPhone: '9876543210' }).expect(201);
  const id = app.body.data._id;
  for (const status of ['Applied', 'Approved']) await api().patch(`/api/admissions/${id}/status`).set(admin()).send({ status }).expect(200);
  const admit = await api().post(`/api/admissions/${id}/admit`).set(admin()).send({ section: 'A' }).expect(201);
  expect(day(admit.body.student.admittedOn)).toBe(formatDay(toDayKey()));
});

test('migration: dry run writes nothing; apply fills only from the Admitted step; existing dates and other records untouched; safe to repeat', async () => {
  const admittedAt = new Date('2024-06-03T09:00:00Z');
  const make = async (name, extra = {}) => (await Student.collection.insertOne({
    name, phone: '9000000091', rollNumber: name, class: '10', section: 'A', school: A.school._id, isActive: true,
    createdAt: new Date('2026-01-01T00:00:00Z'), ...extra,
  })).insertedId;
  const viaAdmissions = await make('Via Admissions');
  const alreadyDated = await make('Already Dated', { admittedOn: new Date('2023-04-01T00:00:00Z') });
  const legacy = await make('Legacy');
  const elsewhere = (await Student.collection.insertOne({ name: 'Other School', phone: '9000000090', rollNumber: '9', class: '10', section: 'A', school: B.school._id, isActive: true })).insertedId;
  const application = (student, school = A.school._id, history = [{ status: 'Applied', at: new Date('2024-05-01') }, { status: 'Admitted', at: admittedAt }]) =>
    Admission.collection.insertOne({ school, applicationNo: `ADM-${student}`, academicYear: '2024-25', studentName: 'x', classApplied: '10', status: 'Admitted', student, history });
  await application(viaAdmissions);
  await application(alreadyDated);
  await application(elsewhere, A.school._id); // points at a student of another school: skipped
  await Admission.collection.insertOne({ school: A.school._id, applicationNo: 'ADM-nohistory', academicYear: '2024-25', studentName: 'y', classApplied: '10', status: 'Admitted', student: legacy, history: [] });

  const dry = await backfillAdmissionDates();
  expect(dry).toMatchObject({ applications: 4, set: 1, alreadyRecorded: 1, noAdmittedStep: 1, otherSchool: 1 });
  expect((await Student.collection.findOne({ _id: viaAdmissions })).admittedOn).toBeUndefined();

  const applied = await backfillAdmissionDates({ apply: true });
  expect(applied.set).toBe(1);
  const read = async (id) => (await Student.collection.findOne({ _id: id })).admittedOn;
  expect(day(await read(viaAdmissions))).toBe('2024-06-03');
  expect(day(await read(alreadyDated))).toBe('2023-04-01');
  expect(await read(legacy)).toBeUndefined(); // no real date on record: left alone, not createdAt
  expect(await read(elsewhere)).toBeUndefined();

  const again = await backfillAdmissionDates({ apply: true });
  expect(again).toMatchObject({ set: 0, alreadyRecorded: 2 });
});
