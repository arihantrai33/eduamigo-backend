// These delete routes used to call document.deleteOne(), which carries no school filter. They now delete by { _id, school }.
// The tenant guard (enforce mode) would turn a regression here into a 500, so each path is exercised for real.
jest.mock('../src/config/firebase', () => ({ db: { ref: () => ({ update: async () => {}, remove: async () => {} }) } }));

const { api, connect, disconnect, clear, auth, seedSchool } = require('./helpers');
const Library = require('../src/models/Library');
const LeaveRequest = require('../src/models/LeaveRequest');
const FeeStructure = require('../src/models/FeeStructure');
const Salary = require('../src/models/Salary');
const Transport = require('../src/models/Transport');
const SchoolClass = require('../src/models/SchoolClass');
const Note = require('../src/models/Note');
const NoteEmbedding = require('../src/models/NoteEmbedding');

let A;
let B;

beforeAll(connect);
afterAll(disconnect);
beforeEach(async () => {
  await clear();
  A = await seedSchool('Alpha School');
  B = await seedSchool('Beta School');
});

const day = new Date('2026-04-10');

// [label, model, url prefix, builder]
const cases = [
  ['library book', Library, '/api/library', (s) => Library.create({ school: s._id, title: 'Atlas', totalCopies: 1, available: 1 })],
  ['reviewed leave request', LeaveRequest, '/api/leaves', (s, ctx) => LeaveRequest.create({
    school: s._id, requestedBy: ctx.parentUser._id, role: 'parent', fromDate: day, toDate: day, reason: 'Family event', status: 'Approved',
  })],
  ['fee structure', FeeStructure, '/api/fee-structures', (s) => FeeStructure.create({
    school: s._id, academicYear: '2026-27', class: '10', feeType: 'Tuition', amount: 100, dueDate: day,
  })],
  ['salary record', Salary, '/api/hr/salaries', (s, ctx) => Salary.create({ school: s._id, teacher: ctx.teacher._id, month: 1, year: 2026, basicSalary: 1000 })],
  ['empty class', SchoolClass, '/api/academic/classes', (s) => SchoolClass.create({ school: s._id, name: '12', sections: [{ name: 'A' }] })],
];

describe.each(cases)('delete %s', (label, Model, prefix, build) => {
  test('the owning school can delete it', async () => {
    const doc = await build(A.school, A);
    const res = await api().delete(`${prefix}/${doc._id}`).set(auth(A.admin));
    expect(res.status).toBe(200);
    expect(await Model.findById(doc._id)).toBeNull();
  });

  test('another school cannot, and the record stays', async () => {
    const doc = await build(A.school, A);
    const res = await api().delete(`${prefix}/${doc._id}`).set(auth(B.admin));
    expect(res.status).toBe(404);
    expect(await Model.findById(doc._id)).toBeTruthy();
  });
});

describe('delete bus', () => {
  test('owner deletes, another school cannot', async () => {
    const bus = (await api().post('/api/transport').set(auth(A.admin))
      .send({ busNumber: 'UP16 1', driverName: 'Ram', driverPhone: '9', routeName: 'North' })).body.data;
    expect((await api().delete(`/api/transport/${bus._id}`).set(auth(B.admin))).status).toBe(404);
    expect(await Transport.findById(bus._id)).toBeTruthy();
    expect((await api().delete(`/api/transport/${bus._id}`).set(auth(A.admin))).status).toBe(200);
    expect(await Transport.findById(bus._id)).toBeNull();
  });
});

describe('delete note', () => {
  test('removes the note and its embeddings for the owning school only', async () => {
    const note = await Note.create({
      school: A.school._id, title: 'Fractions', subject: 'Mathematics', class: '10', section: 'A', uploadedBy: A.teacherUser._id,
    }).catch((e) => { throw new Error(`Note fixture needs more fields: ${e.message}`); });
    await NoteEmbedding.collection.insertOne({ noteId: note._id, school: A.school._id, text: 'x' });
    expect((await api().delete(`/api/notes/${note._id}`).set(auth(B.admin))).status).toBe(404);
    expect(await Note.findById(note._id)).toBeTruthy();
    const res = await api().delete(`/api/notes/${note._id}`).set(auth(A.admin));
    expect(res.status).toBe(200);
    expect(await Note.findById(note._id)).toBeNull();
    expect(await NoteEmbedding.countDocuments({ noteId: note._id })).toBe(0);
  });
});
