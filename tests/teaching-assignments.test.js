// A teacher's subjects and classes were two separate lists, so every combination was allowed. Teaching assignments name the exact
// (class, section, subject) combinations. Teachers without assignments keep the old rule; the migration turns the lists into assignments.
const { api, connect, disconnect, clear, auth, seedSchool, scheduleExam } = require('./helpers');
const Teacher = require('../src/models/Teacher');
const TeachingAssignment = require('../src/models/TeachingAssignment');

beforeAll(connect);
afterAll(disconnect);
beforeEach(clear);

const marks = (ctx, exam) => api().post('/api/marks/save').set(auth(ctx.teacherUser))
  .send({ examId: String(exam._id), marksData: [{ studentId: String(ctx.student._id), marksObtained: 20 }] });

async function twoClassTeacher(ctx) {
  // Maths in 10-A and English in 9-B: with the old two lists this teacher could also mark English in 10-A.
  ctx.teacher.subjects = ['Mathematics', 'English'];
  ctx.teacher.assignedClasses = ['10-A', '9-B'];
  await ctx.teacher.save();
}

describe('teaching assignments', () => {
  test('without assignments the old lists apply (every combination), so existing schools are unchanged', async () => {
    const ctx = await seedSchool();
    await twoClassTeacher(ctx);
    await marks(ctx, await scheduleExam(ctx, { subject: 'English' })).expect(200);
  });

  test('with assignments only the listed combinations are allowed', async () => {
    const ctx = await seedSchool();
    await twoClassTeacher(ctx);
    await api().put(`/api/teachers/${ctx.teacher._id}/assignments`).set(auth(ctx.admin))
      .send({ assignments: [{ class: '10', section: 'A', subject: 'Mathematics' }, { class: '9', section: 'B', subject: 'English' }] }).expect(200);
    await marks(ctx, await scheduleExam(ctx, { subject: 'Mathematics' })).expect(200);
    const res = await marks(ctx, await scheduleExam(ctx, { subject: 'English', title: 'English Mid' }));
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/do not teach/i);
  });

  test('the marking list only offers the exams the teacher teaches', async () => {
    const ctx = await seedSchool();
    await twoClassTeacher(ctx);
    await scheduleExam(ctx, { subject: 'Mathematics' });
    await scheduleExam(ctx, { subject: 'English', title: 'English Mid' });
    await api().put(`/api/teachers/${ctx.teacher._id}/assignments`).set(auth(ctx.admin)).send({ assignments: [{ class: '10', section: 'A', subject: 'Mathematics' }] }).expect(200);
    const res = await api().get('/api/marks/exams?class=10&section=A').set(auth(ctx.teacherUser)).expect(200);
    expect(res.body.data.map((e) => e.subject)).toEqual(['Mathematics']);
  });

  test('a section-less assignment covers every section of the class; a section-specific one only that section', async () => {
    const ctx = await seedSchool();
    await api().put(`/api/teachers/${ctx.teacher._id}/assignments`).set(auth(ctx.admin)).send({ assignments: [{ class: '10', subject: 'Mathematics' }] }).expect(200);
    await marks(ctx, await scheduleExam(ctx, { subject: 'Mathematics' })).expect(200);
    await api().put(`/api/teachers/${ctx.teacher._id}/assignments`).set(auth(ctx.admin)).send({ assignments: [{ class: '10', section: 'B', subject: 'Mathematics' }] }).expect(200);
    await marks(ctx, await scheduleExam(ctx, { subject: 'Mathematics', title: 'Unit' })).expect(403);
  });

  test('assigning a class also lets the teacher see it; removing the class removes its assignments', async () => {
    const ctx = await seedSchool();
    await api().put(`/api/teachers/${ctx.teacher._id}/assignments`).set(auth(ctx.admin)).send({ assignments: [{ class: '7', section: 'C', subject: 'Science' }] }).expect(200);
    const t = await Teacher.findById(ctx.teacher._id);
    expect(t.assignedClasses).toEqual(expect.arrayContaining(['10-A', '7-C']));
    await api().patch(`/api/teachers/${ctx.teacher._id}/remove-class`).set(auth(ctx.admin)).send({ className: '7', section: 'C' }).expect(200);
    expect(await TeachingAssignment.countDocuments({ teacher: ctx.teacher._id })).toBe(0);
  });

  test('duplicates collapse, bad input is refused, and an empty list clears the assignments', async () => {
    const ctx = await seedSchool();
    const put = (assignments) => api().put(`/api/teachers/${ctx.teacher._id}/assignments`).set(auth(ctx.admin)).send({ assignments });
    await put([{ class: '10', section: 'A', subject: 'Mathematics' }, { class: '10', section: 'a', subject: 'mathematics' }]).expect(200);
    expect(await TeachingAssignment.countDocuments({ teacher: ctx.teacher._id })).toBe(1);
    await put([{ class: '10', section: 'A' }]).expect(400);
    await put([{ subject: 'Maths' }]).expect(400);
    await api().put(`/api/teachers/${ctx.teacher._id}/assignments`).set(auth(ctx.admin)).send({ assignments: 'x' }).expect(400);
    await put([]).expect(200);
    expect(await TeachingAssignment.countDocuments({ teacher: ctx.teacher._id })).toBe(0);
  });

  test('only people who manage staff can read or change assignments, and never across schools', async () => {
    const A = await seedSchool();
    const B = await seedSchool();
    await api().get(`/api/teachers/${A.teacher._id}/assignments`).set(auth(A.teacherUser)).expect(403);
    await api().put(`/api/teachers/${A.teacher._id}/assignments`).set(auth(A.teacherUser)).send({ assignments: [] }).expect(403);
    await api().put(`/api/teachers/${A.teacher._id}/assignments`).set(auth(B.admin)).send({ assignments: [{ class: '10', subject: 'Maths' }] }).expect(404);
    await api().get(`/api/teachers/${A.teacher._id}/assignments`).set(auth(B.admin)).expect(404);
    expect(await TeachingAssignment.countDocuments({ school: A.school._id })).toBe(0);
  });

  test('a teacher sees their own assignments with their classes', async () => {
    const ctx = await seedSchool();
    await api().put(`/api/teachers/${ctx.teacher._id}/assignments`).set(auth(ctx.admin)).send({ assignments: [{ class: '10', section: 'A', subject: 'Mathematics', isClassTeacher: true }] }).expect(200);
    const res = await api().get('/api/marks/classes').set(auth(ctx.teacherUser)).expect(200);
    expect(res.body.assignments).toEqual([{ class: '10', section: 'A', subject: 'Mathematics', isClassTeacher: true }]);
  });
});
