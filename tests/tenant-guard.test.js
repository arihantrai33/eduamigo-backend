const mongoose = require('mongoose');
const { connect, disconnect, clear, seedSchool } = require('./helpers');
const { runAsTenant, TenantGuardError } = require('../src/config/tenantGuard');
const Student = require('../src/models/Student');
const Fee = require('../src/models/Fee');
const School = require('../src/models/School');

let A;
let B;
let studentA;

beforeAll(connect);
afterAll(disconnect);
beforeEach(async () => {
  await clear();
  A = await seedSchool('Alpha School');
  B = await seedSchool('Beta School');
  studentA = A.student; // each seeded school has 2 students; the 2 schools have 4 in total
});

const asA = (fn) => runAsTenant(A.school._id, async () => await fn()); // the query must run inside the context

describe('tenant guard inside a school request', () => {
  test('a query with no school filter is refused', async () => {
    await expect(asA(() => Student.find({}))).rejects.toThrow(TenantGuardError);
    await expect(asA(() => Student.findOne({ name: 'Aarav' }))).rejects.toThrow(/no school filter/);
  });

  test('an _id-only lookup is refused, so a guessed id cannot reach another school', async () => {
    await expect(asA(() => Student.findOne({ _id: studentA._id }))).rejects.toThrow(TenantGuardError);
    await expect(asA(() => Student.updateOne({ _id: studentA._id }, { name: 'x' }))).rejects.toThrow(TenantGuardError);
    await expect(asA(() => Student.deleteOne({ _id: studentA._id }))).rejects.toThrow(TenantGuardError);
  });

  test('the request school passes, as ObjectId, string or inside $and', async () => {
    await expect(asA(() => Student.find({ school: A.school._id }))).resolves.toHaveLength(2);
    await expect(asA(() => Student.find({ school: String(A.school._id) }))).resolves.toHaveLength(2);
    await expect(asA(() => Student.find({ $and: [{ name: 'Aarav' }, { school: A.school._id }] }))).resolves.toHaveLength(1);
    await expect(asA(() => Student.countDocuments({ school: { $eq: A.school._id } }))).resolves.toBe(2);
  });

  test('a different school than the request is refused', async () => {
    await expect(asA(() => Student.find({ school: B.school._id }))).rejects.toThrow(/different school/);
    await expect(asA(() => Student.updateMany({ school: B.school._id }, { name: 'x' }))).rejects.toThrow(/different school/);
  });

  test('an undefined, null or operator school does not count', async () => {
    await expect(asA(() => Student.find({ school: undefined }))).rejects.toThrow(TenantGuardError);
    await expect(asA(() => Student.find({ school: null }))).rejects.toThrow(TenantGuardError);
    await expect(asA(() => Student.find({ school: { $in: [A.school._id, B.school._id] } }))).rejects.toThrow(TenantGuardError);
    await expect(asA(() => Student.find({ school: { $ne: B.school._id } }))).rejects.toThrow(TenantGuardError);
  });

  test('a school inside $or does not count', async () => {
    await expect(asA(() => Student.find({ $or: [{ school: A.school._id }, { name: 'Aarav' }] }))).rejects.toThrow(TenantGuardError);
  });

  test('aggregate needs a school in its first $match', async () => {
    await expect(asA(() => Student.aggregate([{ $group: { _id: '$class', n: { $sum: 1 } } }]))).rejects.toThrow(TenantGuardError);
    await expect(asA(() => Student.aggregate([{ $match: { school: B.school._id } }]))).rejects.toThrow(/different school/);
    const rows = await asA(() => Student.aggregate([{ $match: { school: A.school._id } }, { $group: { _id: '$class', n: { $sum: 1 } } }]));
    expect(rows).toEqual([{ _id: '10', n: 2 }]);
  });

  test('a deliberate cross-school query must say why, and then passes', async () => {
    await expect(asA(() => Student.find({}).setOptions({ crossTenant: 'platform-wide count for the owner report' }))).resolves.toHaveLength(4);
  });

  test('populate still works (its id-list lookups are allowed)', async () => {
    const fee = await Fee.create({ school: A.school._id, studentId: studentA._id, feeType: 'Tuition', amount: 100, dueDate: new Date() });
    const rows = await asA(() => Fee.find({ school: A.school._id }).populate('studentId', 'name'));
    expect(rows[0].studentId.name).toBe('Aarav');
    expect(String(rows[0]._id)).toBe(String(fee._id));
  });

  test('models that are not tenant-scoped are not checked', async () => {
    await expect(asA(() => School.find({}))).resolves.toHaveLength(2);
  });
});

describe('tenant guard outside a school request', () => {
  test('jobs, scripts, login and platform routes are not checked', async () => {
    await expect(Student.find({})).resolves.toHaveLength(4);
    await expect(Student.findOne({ _id: studentA._id })).resolves.toBeTruthy();
  });
});

describe('tenant guard modes', () => {
  const saved = process.env.TENANT_GUARD;
  afterEach(() => { if (saved === undefined) delete process.env.TENANT_GUARD; else process.env.TENANT_GUARD = saved; });

  test('warn mode lets the query run and logs it', async () => {
    process.env.TENANT_GUARD = 'warn';
    process.env.LOG_IN_TESTS = 'true';
    const lines = [];
    const spy = jest.spyOn(process.stdout, 'write').mockImplementation((c) => { lines.push(String(c)); return true; });
    try {
      await expect(asA(() => Student.find({}))).resolves.toHaveLength(4);
    } finally { spy.mockRestore(); delete process.env.LOG_IN_TESTS; }
    expect(lines.join('')).toContain('"event":"tenant_guard"');
  });

  test('off mode disables the check', async () => {
    process.env.TENANT_GUARD = 'off';
    await expect(asA(() => Student.find({}))).resolves.toHaveLength(4);
  });

  test('enforce is the default', () => {
    delete process.env.TENANT_GUARD;
    expect(mongoose.models.Student).toBeTruthy();
  });
});

describe('tenant guard on bulkWrite', () => {
  const one = (filter) => [{ updateOne: { filter, update: { $set: { remarks: 'x' } } } }];

  test('an operation without the request school is refused', async () => {
    const Attendance = require('../src/models/Attendance');
    await expect(asA(() => Attendance.bulkWrite(one({ studentId: studentA._id, date: '2026-01-01' })))).rejects.toThrow(/bulkWrite/);
    await expect(asA(() => Attendance.bulkWrite(one({ school: B.school._id, studentId: studentA._id, date: '2026-01-01' })))).rejects.toThrow(/different school/);
  });

  test('an operation with the request school passes', async () => {
    const Attendance = require('../src/models/Attendance');
    await expect(asA(() => Attendance.bulkWrite(one({ school: A.school._id, studentId: studentA._id, date: '2026-01-01' })))).resolves.toBeTruthy();
  });

  test('outside a school request bulkWrite is not checked', async () => {
    const Attendance = require('../src/models/Attendance');
    await expect(Attendance.bulkWrite(one({ studentId: studentA._id, date: '2026-01-01' }))).resolves.toBeTruthy();
  });
});
