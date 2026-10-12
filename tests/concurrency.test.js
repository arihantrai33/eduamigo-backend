// Regression tests for work that happens at the same moment: two teachers saving one class, several staff admitting into
// one class, many payments at once. Each test checks the final data, not only the status codes.
const { api, connect, disconnect, clear, auth, seedSchool } = require('./helpers');
const Attendance = require('../src/models/Attendance');
const Notification = require('../src/models/Notification');
const Student = require('../src/models/Student');
const User = require('../src/models/User');
const Fee = require('../src/models/Fee');
const Counter = require('../src/models/Counter');
const academic = require('../src/services/academic');
const { recordPayment } = require('../src/services/feeService');
const { migrate } = require('../src/scripts/migrate');

let A;
let B;

beforeAll(async () => { await connect(); await Promise.all([Attendance.init(), Student.init(), Fee.init(), Counter.init()]); });
afterAll(disconnect);
beforeEach(async () => {
  await clear();
  A = await seedSchool('Alpha School');
  B = await seedSchool('Beta School');
});

const day = new Date('2026-10-12');
const save = (ctx, records, date = '2026-10-12') => api().post('/api/attendance/bulk').set(auth(ctx.teacherUser)).send({ date, class: '10', section: 'A', records });

describe('attendance saved by several people at once', () => {
  let ids;
  beforeEach(async () => {
    const extra = await Student.insertMany(Array.from({ length: 20 }, (_, i) => ({
      name: `Extra ${i}`, phone: `90000001${String(i).padStart(2, '0')}`, class: '10', section: 'A', rollNumber: String(100 + i), school: A.school._id,
    })));
    ids = [A.student._id, ...extra.map((s) => s._id)].map(String);
  });

  test('8 parallel saves of one class all succeed and leave exactly one row per student', async () => {
    const records = ids.map((studentId, i) => ({ studentId, status: i === 0 ? 'Absent' : 'Present' }));
    const results = await Promise.all(Array.from({ length: 8 }, () => save(A, records)));
    expect(results.map((r) => r.status)).toEqual(Array(8).fill(200));
    const rows = await Attendance.find({ school: A.school._id, date: day });
    expect(rows).toHaveLength(ids.length);
    expect(new Set(rows.map((r) => String(r.studentId))).size).toBe(ids.length);
    expect(rows.find((r) => String(r.studentId) === ids[0]).status).toBe('Absent');
  });

  test('the parent hears about an absence once, even when the class is saved twice at the same moment', async () => {
    const records = [{ studentId: ids[0], status: 'Absent' }];
    await Promise.all([save(A, records), save(A, records), save(A, records)]);
    expect(await Notification.countDocuments({ recipient: A.parentUser._id, type: 'Attendance' })).toBe(1);
  });

  test('a real change is still announced: Absent, then Present, then Absent again', async () => {
    await save(A, [{ studentId: ids[0], status: 'Absent' }]).expect(200);
    await save(A, [{ studentId: ids[0], status: 'Present' }]).expect(200);
    await save(A, [{ studentId: ids[0], status: 'Absent' }]).expect(200);
    expect(await Notification.countDocuments({ recipient: A.parentUser._id, type: 'Attendance' })).toBe(2);
  });

  test('a duplicate-key clash on the first create is retried and the save succeeds', async () => {
    const original = Attendance.findOneAndUpdate.bind(Attendance);
    let failed = 0;
    const spy = jest.spyOn(Attendance, 'findOneAndUpdate').mockImplementation((...args) => {
      if (failed < 2) { failed += 1; return Promise.reject(Object.assign(new Error('E11000 duplicate key'), { code: 11000 })); }
      return original(...args);
    });
    try {
      const res = await save(A, [{ studentId: ids[0], status: 'Present' }]);
      expect(res.status).toBe(200);
    } finally { spy.mockRestore(); }
    expect(failed).toBe(2);
    expect(await Attendance.countDocuments({ school: A.school._id, date: day })).toBe(1);
  });

  test('a clash that never clears is reported, not retried forever', async () => {
    const spy = jest.spyOn(Attendance, 'findOneAndUpdate').mockImplementation(() => Promise.reject(Object.assign(new Error('E11000 duplicate key'), { code: 11000 })));
    try {
      const res = await save(A, [{ studentId: ids[0], status: 'Present' }]);
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(spy.mock.calls.length).toBe(4);
    } finally { spy.mockRestore(); }
  });

  test('another school is not touched', async () => {
    await Promise.all([save(A, [{ studentId: ids[0], status: 'Absent' }]), save(A, [{ studentId: ids[1], status: 'Present' }])]);
    expect(await Attendance.countDocuments({ school: B.school._id })).toBe(0);
  });
});

describe('admissions into one class at the same moment', () => {
  const admit = (i, extra = {}) => api().post('/api/students').set(auth(A.admin))
    .send({ name: `New ${i}`, phone: `91000000${String(i).padStart(2, '0')}`, class: '10', section: 'A', ...extra });

  test('10 parallel admissions all succeed with different roll numbers and no leftover accounts', async () => {
    const usersBefore = await User.countDocuments({ school: A.school._id });
    const studentsBefore = await Student.countDocuments({ school: A.school._id });
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => admit(i)));
    expect(results.map((r) => r.status)).toEqual(Array(10).fill(201));
    const rolls = results.map((r) => r.body.data.rollNumber);
    expect(new Set(rolls).size).toBe(10);
    expect(await Student.countDocuments({ school: A.school._id })).toBe(studentsBefore + 10);
    expect(await User.countDocuments({ school: A.school._id })).toBe(usersBefore + 10); // one student login each, none orphaned
    const admissionNos = results.map((r) => r.body.data.admissionNo);
    expect(new Set(admissionNos).size).toBe(10);
  });

  test('the same class in another school keeps its own numbering', async () => {
    const [a, b] = await Promise.all([admit(1), api().post('/api/students').set(auth(B.admin)).send({ name: 'Other', phone: '9100000099', class: '10', section: 'A' })]);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body.data.rollNumber).toBe('2'); // seeded student has roll 1 in each school
    expect(b.body.data.rollNumber).toBe('2');
  });

  test('a roll-number clash from another server is retried after rolling back, leaving nothing behind', async () => {
    const usersBefore = await User.countDocuments({ school: A.school._id });
    const spy = jest.spyOn(academic, 'nextRollNumber').mockResolvedValueOnce('1'); // already taken by the seeded student
    let res;
    try { res = await admit(1); } finally { spy.mockRestore(); }
    expect(res.status).toBe(201);
    expect(res.body.data.rollNumber).toBe('2');
    expect(await User.countDocuments({ school: A.school._id })).toBe(usersBefore + 1);
    expect(await Student.countDocuments({ school: A.school._id, name: 'New 1' })).toBe(1);
  });

  test('a roll number typed by the admin that is already taken is refused, not changed, and creates nothing', async () => {
    const usersBefore = await User.countDocuments({ school: A.school._id });
    const res = await admit(1, { rollNumber: '1' });
    expect(res.status).toBe(409);
    expect(await User.countDocuments({ school: A.school._id })).toBe(usersBefore);
    expect(await Student.countDocuments({ school: A.school._id, name: 'New 1' })).toBe(0);
  });
});

describe('fee receipt numbers', () => {
  const year = new Date().getUTCFullYear();
  const makeFees = (ctx, n) => Fee.insertMany(Array.from({ length: n }, (_, i) => ({
    school: ctx.school._id, studentId: ctx.student._id, feeType: `Type ${i}`, amount: 1000, dueDate: day,
  })));
  const payAll = (ctx, fees) => Promise.all(fees.map((f) => recordPayment({ school: ctx.school._id, feeId: f._id, amount: 500, mode: 'Cash', collectedBy: ctx.admin._id })));
  const receipts = async (ctx) => (await Fee.find({ school: ctx.school._id })).flatMap((f) => f.payments.map((p) => p.receiptNo));

  test('40 payments at once get 40 different, consecutive numbers per school, and schools count separately', async () => {
    const [feesA, feesB] = await Promise.all([makeFees(A, 40), makeFees(B, 12)]);
    await Promise.all([payAll(A, feesA), payAll(B, feesB)]);
    const a = await receipts(A);
    const b = await receipts(B);
    expect(new Set(a).size).toBe(40);
    expect([...a].sort()).toEqual(Array.from({ length: 40 }, (_, i) => `RCPT-${year}-${String(i + 1).padStart(6, '0')}`));
    expect([...b].sort()).toEqual(Array.from({ length: 12 }, (_, i) => `RCPT-${year}-${String(i + 1).padStart(6, '0')}`));
  });

  test('two payments on one fee at once are both recorded once with different numbers', async () => {
    const [fee] = await makeFees(A, 1);
    await Promise.all([payAll(A, [fee]), payAll(A, [fee])]);
    const stored = await Fee.findById(fee._id);
    expect(stored.payments).toHaveLength(2);
    expect(stored.paidAmount).toBe(1000);
    expect(new Set(stored.payments.map((p) => p.receiptNo)).size).toBe(2);
  });

  test('the very first receipt of the year can be asked for by many requests at once', async () => {
    const numbers = await Promise.all(Array.from({ length: 15 }, () => Counter.next(A.school._id, 'receipt:2099')));
    expect([...numbers].sort((x, y) => x - y)).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
  });

  test('the database refuses a second use of a receipt number in one school, but allows it in another', async () => {
    const mk = (ctx, receiptNo) => Fee.create({
      school: ctx.school._id, studentId: ctx.student._id, feeType: 'X', amount: 10, dueDate: day,
      payments: [{ amount: 10, mode: 'Cash', receiptNo }],
    });
    await mk(A, 'RCPT-DUP-1');
    await expect(mk(A, 'RCPT-DUP-1')).rejects.toMatchObject({ code: 11000 });
    await expect(mk(B, 'RCPT-DUP-1')).resolves.toBeTruthy();
  });

  test('fees without payments are not affected by the unique index', async () => {
    await expect(makeFees(A, 5)).resolves.toHaveLength(5);
  });

  test('old receipt numbers stay as they are, and new ones continue from the counter', async () => {
    await Fee.create({ school: A.school._id, studentId: A.student._id, feeType: 'Old', amount: 10, dueDate: day, payments: [{ amount: 10, mode: 'Cash', receiptNo: 'RCPT-20250101-ABC123' }] });
    const [fee] = await makeFees(A, 1);
    await payAll(A, [fee]);
    expect(await receipts(A)).toEqual(expect.arrayContaining(['RCPT-20250101-ABC123', `RCPT-${year}-000001`]));
  });
});

describe('migration check for duplicate receipt numbers', () => {
  test('duplicates already in the data are reported and left untouched', async () => {
    await Fee.collection.dropIndex('receipt_unique_per_school');
    try {
      const mk = () => ({ school: A.school._id, studentId: A.student._id, feeType: 'X', amount: 10, dueDate: day, status: 'Partial', payments: [{ amount: 10, mode: 'Cash', receiptNo: 'R-SAME' }] });
      await Fee.collection.insertMany([mk(), mk()]);
      const report = await migrate({ apply: false, quiet: true });
      expect(report['receipts.duplicate_numbers_need_review']).toBe(1);
      expect(await Fee.countDocuments({ 'payments.receiptNo': 'R-SAME' })).toBe(2);
    } finally {
      await Fee.deleteMany({});
      await Fee.syncIndexes();
    }
  });
});
