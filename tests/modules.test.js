const { api, connect, disconnect, clear, auth, seedSchool } = require('./helpers');
const Attendance = require('../src/models/Attendance');
const Notification = require('../src/models/Notification');
const Fee = require('../src/models/Fee');
const Salary = require('../src/models/Salary');

let A;
let B;

beforeAll(connect);
afterAll(disconnect);
beforeEach(async () => {
  await clear();
  A = await seedSchool('Alpha School');
  B = await seedSchool('Beta School');
});

describe('attendance', () => {
  const body = (ctx, status = 'Absent', date = '2026-09-01') => ({
    date, class: '10', section: 'A', records: [{ studentId: String(ctx.student._id), status }],
  });

  test('teacher marks own class; re-saving updates instead of duplicating', async () => {
    await api().post('/api/attendance/bulk').set(auth(A.teacherUser)).send(body(A, 'Absent')).expect(200);
    await api().post('/api/attendance/bulk').set(auth(A.teacherUser)).send(body(A, 'Present')).expect(200);
    const rows = await Attendance.find({ studentId: A.student._id });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('Present');
    expect(rows[0].date.toISOString()).toBe('2026-09-01T00:00:00.000Z');
  });

  test('parent is notified once for an absence, not on every save', async () => {
    await api().post('/api/attendance/bulk').set(auth(A.teacherUser)).send(body(A, 'Absent')).expect(200);
    await api().post('/api/attendance/bulk').set(auth(A.teacherUser)).send(body(A, 'Absent')).expect(200);
    const n = await Notification.countDocuments({ recipient: A.parentUser._id, type: 'Attendance' });
    expect(n).toBe(1);
  });

  test('teacher cannot mark a class they are not assigned to', async () => {
    const res = await api().post('/api/attendance/bulk').set(auth(A.teacherUser))
      .send({ date: '2026-09-01', class: '10', section: 'B', records: [{ studentId: String(A.otherStudent._id), status: 'Present' }] });
    expect(res.status).toBe(403);
  });

  test('students from another class or school are rejected', async () => {
    const res = await api().post('/api/attendance/bulk').set(auth(A.admin))
      .send({ date: '2026-09-01', class: '10', section: 'A', records: [{ studentId: String(B.student._id), status: 'Present' }] });
    expect(res.status).toBe(400);
  });

  test('future dates are rejected', async () => {
    const res = await api().post('/api/attendance/bulk').set(auth(A.teacherUser)).send(body(A, 'Present', '2099-01-01'));
    expect(res.status).toBe(400);
  });

  test('percentage excludes holidays and counts late as attended', async () => {
    const days = [['2026-09-01', 'Present'], ['2026-09-02', 'Late'], ['2026-09-03', 'Absent'], ['2026-09-04', 'Holiday']];
    for (const [date, status] of days) {
      await api().post('/api/attendance/bulk').set(auth(A.teacherUser)).send(body(A, status, date)).expect(200);
    }
    const res = await api().get('/api/attendance/child-summary').set(auth(A.parentUser));
    expect(res.body.data.total).toBe(3);
    expect(res.body.data.percentage).toBeCloseTo(66.7, 1);
  });

  test('bulk attendance from admin works and is school-scoped', async () => {
    const res = await api().post('/api/bulk/attendance').set(auth(A.admin))
      .send({ className: '10', section: 'A', date: '2026-09-01', status: 'Present' });
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(await Attendance.countDocuments({ school: B.school._id })).toBe(0);
  });
});

describe('fees', () => {
  async function structure(ctx, overrides = {}) {
    const res = await api().post('/api/fee-structures').set(auth(ctx.admin)).send({
      academicYear: '2026-27', class: '10', section: 'All', feeType: 'Tuition', amount: 5000, dueDate: '2026-10-10', ...overrides,
    });
    expect(res.status).toBe(201);
    return res.body.data;
  }

  test('applying a structure bills every student of the class once', async () => {
    const s = await structure(A);
    const first = await api().post(`/api/fee-structures/${s._id}/apply`).set(auth(A.admin));
    expect(first.body.data.created).toBe(2);
    const second = await api().post(`/api/fee-structures/${s._id}/apply`).set(auth(A.admin));
    expect(second.body.data.created).toBe(0);
    expect(await Fee.countDocuments({ school: B.school._id })).toBe(0);
  });

  test('the same fee structure can exist in two schools', async () => {
    await structure(A);
    await structure(B);
  });

  test('partial payments, receipts and overpayment protection', async () => {
    const s = await structure(A);
    await api().post(`/api/fee-structures/${s._id}/apply`).set(auth(A.admin));
    const fee = await Fee.findOne({ studentId: A.student._id });

    const p1 = await api().patch(`/api/fees/${fee._id}/pay`).set(auth(A.admin)).send({ amount: 2000, mode: 'UPI' });
    expect(p1.status).toBe(200);
    expect(p1.body.data.status).toBe('Partial');
    expect(p1.body.payment.receiptNo).toMatch(/^RCPT-/);

    const over = await api().patch(`/api/fees/${fee._id}/pay`).set(auth(A.admin)).send({ amount: 9999 });
    expect(over.status).toBe(400);

    const p2 = await api().patch(`/api/fees/${fee._id}/pay`).set(auth(A.admin)).send({});
    expect(p2.body.data.status).toBe('Paid');
    expect(p2.body.data.paidAmount).toBe(5000);

    const Student = require('../src/models/Student');
    expect((await Student.findById(A.student._id)).feeStatus).toBe('Paid');
    const my = await api().get('/api/fees/my').set(auth(A.parentUser));
    expect(my.body.summary).toEqual({ total: 5000, totalPaid: 5000, totalDue: 0 });
  });

  test('reapply changes only fees from that structure', async () => {
    const tuition = await structure(A);
    const transport = await structure(A, { feeType: 'Transport', amount: 1000 });
    await api().post(`/api/fee-structures/${tuition._id}/apply`).set(auth(A.admin));
    await api().post(`/api/fee-structures/${transport._id}/apply`).set(auth(A.admin));
    await structure(B);

    await api().put(`/api/fee-structures/${tuition._id}/reapply`).set(auth(A.admin)).send({ amount: 6000 }).expect(200);

    const transportFees = await Fee.find({ school: A.school._id, feeType: 'Transport' });
    expect(transportFees.every((f) => f.amount === 1000)).toBe(true);
    const tuitionFees = await Fee.find({ school: A.school._id, feeType: 'Tuition' });
    expect(tuitionFees.every((f) => f.amount === 6000)).toBe(true);
  });

  test('a structure that has been billed cannot be deleted', async () => {
    const s = await structure(A);
    await api().post(`/api/fee-structures/${s._id}/apply`).set(auth(A.admin));
    const res = await api().delete(`/api/fee-structures/${s._id}`).set(auth(A.admin));
    expect(res.status).toBe(409);
  });
});

describe('HR', () => {
  test('creating and updating a salary computes net salary (Mongoose 9 hooks)', async () => {
    const res = await api().post('/api/hr/salaries').set(auth(A.admin))
      .send({ teacher: String(A.teacher._id), month: 9, year: 2026, basicSalary: 30000, allowances: 2000, deductions: 500 });
    expect(res.status).toBe(201);
    expect(res.body.data.netSalary).toBe(31500);
    const upd = await api().put(`/api/hr/salaries/${res.body.data._id}`).set(auth(A.admin)).send({ deductions: 1500 });
    expect(upd.body.data.netSalary).toBe(30500);
  });

  test('cannot create a salary for another school\'s teacher', async () => {
    const res = await api().post('/api/hr/salaries').set(auth(A.admin))
      .send({ teacher: String(B.teacher._id), month: 9, year: 2026, basicSalary: 1 });
    expect(res.status).toBe(400);
  });

  test('monthly generation is idempotent', async () => {
    await api().post('/api/hr/salaries/generate').set(auth(A.admin)).send({ month: 9, year: 2026 }).expect(200);
    const again = await api().post('/api/hr/salaries/generate').set(auth(A.admin)).send({ month: 9, year: 2026 });
    expect(again.body.data).toBe(0);
    expect(await Salary.countDocuments({ school: A.school._id })).toBe(1);
  });

  test('staff leave days are calculated', async () => {
    const res = await api().post('/api/hr/leaves').set(auth(A.admin))
      .send({ teacher: String(A.teacher._id), leaveType: 'Casual', fromDate: '2026-09-01', toDate: '2026-09-03' });
    expect(res.status).toBe(201);
    expect(res.body.data.days).toBe(3);
  });
});

describe('leave requests', () => {
  test('parent applies for child, class teacher approves, parent is notified', async () => {
    const applied = await api().post('/api/leaves/apply').set(auth(A.parentUser))
      .send({ leaveType: 'Sick', fromDate: '2026-09-10', toDate: '2026-09-11', reason: 'Fever' });
    expect(applied.status).toBe(201);
    expect(applied.body.data.class).toBe('10');
    expect(applied.body.data.days).toBe(2);

    const pending = await api().get('/api/leaves/pending').set(auth(A.teacherUser));
    expect(pending.body.data).toHaveLength(1);

    await api().patch(`/api/leaves/${applied.body.data._id}/review`).set(auth(A.teacherUser)).send({ status: 'Approved' }).expect(200);
    const notes = await api().get('/api/notifications/my').set(auth(A.parentUser));
    expect(notes.body.data.some((n) => n.title === 'Leave approved')).toBe(true);

    const quota = await api().get('/api/leaves/quota').set(auth(A.parentUser));
    expect(quota.body.data.used).toBe(2);
  });

  test('admin of another school cannot see or review the leave', async () => {
    const applied = await api().post('/api/leaves/apply').set(auth(A.studentUser))
      .send({ leaveType: 'Sick', fromDate: '2026-09-10', toDate: '2026-09-10', reason: 'Fever' });
    const list = await api().get('/api/leaves').set(auth(B.admin));
    expect(list.body.data).toHaveLength(0);
    const review = await api().patch(`/api/leaves/${applied.body.data._id}/review`).set(auth(B.admin)).send({ status: 'Approved' });
    expect(review.status).toBe(404);
  });
});

describe('exams and results', () => {
  const exam = { class: '10', section: 'A', subject: 'Mathematics', examName: 'Mid Term', academicYear: '2026-27' };

  test('marks above maximum are rejected', async () => {
    const res = await api().post('/api/marks/save').set(auth(A.teacherUser))
      .send({ ...exam, maxMarks: 50, marksData: [{ studentId: String(A.student._id), marksObtained: 51 }] });
    expect(res.status).toBe(400);
  });

  test('teacher cannot save marks for a class they do not teach', async () => {
    const res = await api().post('/api/marks/save').set(auth(A.teacherUser))
      .send({ ...exam, section: 'B', maxMarks: 50, marksData: [{ studentId: String(A.otherStudent._id), marksObtained: 20 }] });
    expect(res.status).toBe(403);
  });

  test('published results are visible to the parent and locked for editing', async () => {
    await api().post('/api/marks/save').set(auth(A.teacherUser))
      .send({ ...exam, maxMarks: 100, marksData: [{ studentId: String(A.student._id), marksObtained: 91 }] }).expect(200);
    await api().patch('/api/marks/publish').set(auth(A.teacherUser)).send(exam).expect(200);

    const parent = await api().get(`/api/exams/student/${A.student._id}/results`).set(auth(A.parentUser));
    expect(parent.status).toBe(200);
    expect(parent.body.data[0].grade).toBe('A+');

    const edit = await api().post('/api/marks/save').set(auth(A.teacherUser))
      .send({ ...exam, maxMarks: 100, marksData: [{ studentId: String(A.student._id), marksObtained: 10 }] });
    expect(edit.status).toBe(409);
  });

  test('parents cannot read results of a child that is not theirs', async () => {
    const res = await api().get(`/api/exams/student/${A.otherStudent._id}/results`).set(auth(A.parentUser));
    expect(res.status).toBe(404);
  });

  test('exam schedule CRUD for admin; students see only their class', async () => {
    await api().post('/api/exams').set(auth(A.admin)).send({ title: 'Maths', subject: 'Mathematics', class: '10', section: 'A', date: '2026-11-01' }).expect(201);
    await api().post('/api/exams').set(auth(A.admin)).send({ title: 'Science', subject: 'Science', class: '9', date: '2026-11-02' }).expect(201);
    const student = await api().get('/api/exams').set(auth(A.studentUser));
    expect(student.body.data.map((e) => e.title)).toEqual(['Maths']);
    const other = await api().get('/api/exams').set(auth(B.admin));
    expect(other.body.data).toHaveLength(0);
  });
});

describe('students and families', () => {
  test('a sibling is linked to the existing parent account', async () => {
    const res = await api().post('/api/students').set(auth(A.admin)).send({
      name: 'Kabir', email: 'kabir@x.com', phone: '9111111111', rollNumber: '2', class: 'Class 10', section: 'a',
      parentName: 'Parent', parentEmail: A.parentUser.email,
    });
    expect(res.status).toBe(201);
    expect(res.body.linkedExistingParent).toBe(true);
    expect(res.body.data.class).toBe('10');
    expect(res.body.data.section).toBe('A');
    const kids = await api().get('/api/parents/my-child').set(auth(A.parentUser));
    expect(kids.body.data.children.map((c) => c.name).sort()).toEqual(['Aarav', 'Kabir']);
  });

  test('roll numbers are unique per class in a school, not across schools', async () => {
    const dup = await api().post('/api/students').set(auth(A.admin)).send({
      name: 'X', email: 'x1@x.com', phone: '1', rollNumber: '1', class: '10', section: 'A',
    });
    expect(dup.status).toBe(409);
    const otherSchool = await api().post('/api/students').set(auth(B.admin)).send({
      name: 'Y', email: 'y1@x.com', phone: '1', rollNumber: '2', class: '10', section: 'A',
    });
    expect(otherSchool.status).toBe(201);
  });

  test('update cannot move a student to another school', async () => {
    await api().put(`/api/students/${A.student._id}`).set(auth(A.admin)).send({ school: String(B.school._id), name: 'Aarav K' }).expect(200);
    const res = await api().get(`/api/students/${A.student._id}`).set(auth(A.admin));
    expect(res.body.data.name).toBe('Aarav K');
    expect(String(res.body.data.school)).toBe(String(A.school._id));
  });
});

describe('timetable', () => {
  test('admin builds a day period by period and lists it', async () => {
    const t1 = { class: '10', section: 'A', day: 'Monday', period: { no: 2, subject: 'Science', teacher: String(A.teacher._id), startTime: '09:00', endTime: '09:40' } };
    const created = await api().post('/api/timetable').set(auth(A.admin)).send(t1);
    expect(created.status).toBe(201);
    await api().put(`/api/timetable/${created.body.data._id}`).set(auth(A.admin))
      .send({ period: { no: 1, subject: 'Mathematics', startTime: '08:20', endTime: '09:00' } }).expect(200);
    await api().put(`/api/timetable/${created.body.data._id}`).set(auth(A.admin))
      .send({ period: { no: 2, subject: 'Physics' } }).expect(200);
    const list = await api().get('/api/timetable').set(auth(A.admin));
    expect(list.body.data[0].periods.map((p) => p.subject)).toEqual(['Mathematics', 'Physics']);
    const mine = await api().get('/api/timetable/my').set(auth(A.studentUser));
    expect(mine.body.data).toHaveLength(1);
    const other = await api().get('/api/timetable').set(auth(B.admin));
    expect(other.body.data).toHaveLength(0);
  });

  test('cannot assign a teacher from another school', async () => {
    const res = await api().post('/api/timetable').set(auth(A.admin))
      .send({ class: '10', section: 'A', day: 'Tuesday', period: { no: 1, subject: 'X', teacher: String(B.teacher._id) } });
    expect(res.status).toBe(400);
  });
});

describe('notifications read state', () => {
  test('marking one notification as read', async () => {
    const sent = await api().post('/api/notifications/send').set(auth(A.admin)).send({ title: 'Holiday', message: 'Closed tomorrow', targetRole: 'parent' });
    let mine = await api().get('/api/notifications/my').set(auth(A.parentUser));
    expect(mine.body.unread).toBe(1);
    await api().patch(`/api/notifications/${sent.body.data._id}/read`).set(auth(A.parentUser)).expect(200);
    mine = await api().get('/api/notifications/my').set(auth(A.parentUser));
    expect(mine.body.unread).toBe(0);
    const teacher = await api().get('/api/notifications/my').set(auth(A.teacherUser));
    expect(teacher.body.data).toHaveLength(0);
  });
});
