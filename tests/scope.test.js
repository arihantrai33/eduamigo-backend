// Data scope: which records a role may reach once it has the permission. These are characterisation tests: they pin today's behaviour
// of every place that used to decide "teacher: only own classes, admin: everything" from a role name, so that moving those decisions to
// one scope service (services/scope.js) cannot change who sees what.
const { api, connect, disconnect, clear, auth, makeUser, seedSchool, scheduleExam } = require('./helpers');
const Student = require('../src/models/Student');
const Note = require('../src/models/Note');
const LeaveRequest = require('../src/models/LeaveRequest');
const Event = require('../src/models/Event');

let A;
let B; // another school
let outsider; // a student of 10-B (the teacher teaches 10-A only)
beforeAll(connect);
afterAll(disconnect);
beforeEach(async () => {
  await clear();
  A = await seedSchool('Alpha School');
  B = await seedSchool('Beta School');
  outsider = A.otherStudent; // class 10, section B
});

const get = (user, path) => api().get(path).set(auth(user));
const post = (user, path, body) => api().post(path).set(auth(user)).send(body);
const patch = (user, path, body) => api().patch(path).set(auth(user)).send(body);
const DENIED = [403, 404];

describe('students', () => {
  test('the office lists every student; a teacher only the classes assigned to them; an accountant every student', async () => {
    const admin = await get(A.admin, '/api/students');
    const accountant = await get(await makeUser(A.school, 'accountant'), '/api/students');
    const teacher = await get(A.teacherUser, '/api/students');
    expect(admin.body.data.map((s) => s.name).sort()).toEqual(['Aarav', 'Diya']);
    expect(accountant.body.data.map((s) => s.name).sort()).toEqual(['Aarav', 'Diya']);
    expect(teacher.body.data.map((s) => s.name)).toEqual(['Aarav']);
  });

  test('academic records of a student: school for the office, assigned class for a teacher, none for a fee clerk', async () => {
    const own = A.student._id;
    const other = outsider._id;
    expect((await get(A.admin, `/api/attendance/student/${other}/summary`)).status).toBe(200);
    expect((await get(A.teacherUser, `/api/attendance/student/${own}/summary`)).status).toBe(200);
    expect(DENIED).toContain((await get(A.teacherUser, `/api/attendance/student/${other}/summary`)).status);
    expect(DENIED).toContain((await get(await makeUser(A.school, 'accountant'), `/api/attendance/student/${own}/summary`)).status);
    // relationships: a parent reads their own child only, a student only themselves
    expect((await get(A.parentUser, `/api/attendance/student/${own}/summary`)).status).toBe(200);
    expect(DENIED).toContain((await get(A.parentUser, `/api/attendance/student/${other}/summary`)).status);
    expect(DENIED).toContain((await get(A.studentUser, `/api/attendance/student/${other}/summary`)).status);
  });
});

describe('attendance', () => {
  const today = () => new Date().toISOString().slice(0, 10);
  const mark = (user, student) => post(user, '/api/attendance/bulk', { date: today(), class: student.class, section: student.section, records: [{ studentId: String(student._id), status: 'Present' }] });

  test('a teacher marks only their class; the office marks any class', async () => {
    expect((await mark(A.teacherUser, A.student)).status).toBe(200);
    expect((await mark(A.teacherUser, outsider)).status).toBe(403);
    expect((await mark(A.admin, outsider)).status).toBe(200);
    expect((await post(A.teacherUser, '/api/attendance/mark', { studentId: String(outsider._id), date: today(), status: 'Absent' })).status).toBe(403);
  });

  test('class attendance listing follows the same scope', async () => {
    await mark(A.admin, outsider);
    expect((await get(A.teacherUser, '/api/attendance/class/10?section=B')).status).toBe(403);
    expect((await get(A.teacherUser, '/api/attendance/class/10?section=A')).status).toBe(200);
    expect((await get(A.admin, '/api/attendance/class/10?section=B')).status).toBe(200);
  });
});

describe('results and marks', () => {
  test('exam results: the office may list the whole school; a teacher must name an assigned class', async () => {
    expect((await get(A.admin, '/api/exams/results')).status).toBe(200);
    expect((await get(A.teacherUser, '/api/exams/results')).status).toBe(400);
    expect((await get(A.teacherUser, '/api/exams/results?class=10&section=B')).status).toBe(403);
    expect((await get(A.teacherUser, '/api/exams/results?class=10&section=A')).status).toBe(200);
  });

  test('marking: exams of a class a teacher does not teach are refused; the office is not limited', async () => {
    expect((await get(A.teacherUser, '/api/marks/exams?class=10&section=B')).status).toBe(403);
    expect((await get(A.teacherUser, '/api/marks/exams?class=10&section=A')).status).toBe(200);
    expect((await get(A.admin, '/api/marks/exams?class=10&section=B')).status).toBe(200);
  });

  test('a subject teacher cannot enter marks for another subject of their own class', async () => {
    const maths = await scheduleExam(A, { subject: 'Mathematics', section: 'A' });
    const science = await scheduleExam(A, { subject: 'Science', section: 'A', title: 'Science Test' });
    const listed = (await get(A.teacherUser, '/api/marks/exams?class=10&section=A')).body.data;
    const ids = (listed.exams || listed).map((e) => String(e._id || e.exam?._id));
    expect(ids).toContain(String(maths._id));
    expect(ids).not.toContain(String(science._id));
  });

  test('report cards: a class report for the office or the class teacher; a student card by relationship', async () => {
    expect((await get(A.admin, '/api/report-cards?class=10&section=B')).status).toBe(200);
    expect((await get(A.teacherUser, '/api/report-cards?class=10&section=B')).status).toBe(403);
    expect((await get(A.teacherUser, '/api/report-cards?class=10&section=A')).status).toBe(200);
    expect((await get(A.teacherUser, `/api/report-cards/student/${outsider._id}`)).status).toBe(404);
    expect((await get(A.admin, `/api/report-cards/student/${outsider._id}`)).status).toBe(200);
    expect((await get(A.studentUser, '/api/report-cards/student/me')).status).toBe(200);
  });
});

describe('leave requests', () => {
  const leaveOf = (student, over = {}) => LeaveRequest.create({
    school: A.school._id, requestedBy: student.userId, role: 'student', name: student.name, studentId: student._id,
    class: student.class, section: student.section, leaveType: 'Sick', fromDate: new Date(), toDate: new Date(), days: 1, reason: 'Fever', ...over,
  });

  test('a teacher sees and reviews leave only for students of their classes; the office reviews all', async () => {
    const mine = await leaveOf(A.student);
    const theirs = await leaveOf(outsider);
    const pending = (await get(A.teacherUser, '/api/leaves/pending')).body.data.map((l) => String(l._id));
    expect(pending).toContain(String(mine._id));
    expect(pending).not.toContain(String(theirs._id));
    expect((await patch(A.teacherUser, `/api/leaves/${theirs._id}/review`, { status: 'Approved' })).status).toBe(403);
    expect((await patch(A.teacherUser, `/api/leaves/${mine._id}/review`, { status: 'Approved' })).status).toBe(200);
    expect((await patch(A.admin, `/api/leaves/${theirs._id}/review`, { status: 'Approved' })).status).toBe(200);
    const all = (await get(A.admin, '/api/leaves/pending')).body.data;
    expect(Array.isArray(all)).toBe(true);
  });

  test('the full school list is for the office only', async () => {
    expect((await get(A.admin, '/api/leaves')).status).toBe(200);
    expect((await get(A.teacherUser, '/api/leaves')).status).toBe(403);
  });
});

describe('study material', () => {
  const noteBy = (user, over = {}) => Note.create({ school: A.school._id, title: 'N', subject: 'Mathematics', type: 'Notes', class: '10', section: 'A', fileUrl: 'https://x/a.pdf', uploadedBy: user._id, teacherName: user.name, ...over });

  test('a teacher lists only their own uploads and deletes only their own; the office lists and deletes any', async () => {
    const other = await makeUser(A.school, 'teacher');
    const mine = await noteBy(A.teacherUser);
    const theirs = await noteBy(other);
    const list = (await get(A.teacherUser, '/api/notes/teacher')).body.data.map((n) => String(n._id));
    expect(list).toEqual([String(mine._id)]);
    expect((await get(A.admin, '/api/notes/teacher')).body.data).toHaveLength(2);
    expect((await api().delete(`/api/notes/${theirs._id}`).set(auth(A.teacherUser))).status).toBe(403);
    expect((await api().post(`/api/notes/${theirs._id}/reprocess`).set(auth(A.teacherUser))).status).toBe(403);
    expect((await api().delete(`/api/notes/${mine._id}`).set(auth(A.teacherUser))).status).toBe(200);
    expect((await api().delete(`/api/notes/${theirs._id}`).set(auth(A.admin))).status).toBe(200);
  });
});

describe('calendar audience', () => {
  test('the office sees every event; others see events for everyone and for their own role', async () => {
    await Event.create([
      { school: A.school._id, title: 'For all', date: new Date(), targetRole: 'all', createdBy: A.admin._id },
      { school: A.school._id, title: 'Teachers only', date: new Date(), targetRole: 'teacher', createdBy: A.admin._id },
      { school: A.school._id, title: 'Parents only', date: new Date(), targetRole: 'parent', createdBy: A.admin._id },
    ]);
    const titles = async (user) => (await get(user, '/api/events')).body.data.map((e) => e.title).sort();
    expect(await titles(A.admin)).toEqual(['For all', 'Parents only', 'Teachers only']);
    expect(await titles(A.teacherUser)).toEqual(['For all', 'Teachers only']);
    expect(await titles(A.parentUser)).toEqual(['For all', 'Parents only']);
    expect(await titles(await makeUser(A.school, 'accountant'))).toEqual(['For all']);
  });
});

describe('another school', () => {
  test('none of it crosses schools', async () => {
    expect(DENIED).toContain((await get(B.admin, `/api/attendance/student/${A.student._id}/summary`)).status);
    expect(DENIED).toContain((await get(B.admin, `/api/report-cards/student/${A.student._id}`)).status);
  });
});
