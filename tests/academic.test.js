const { api, connect, disconnect, clear, auth, seedSchool } = require('./helpers');
const Student = require('../src/models/Student');
const Teacher = require('../src/models/Teacher');
const SchoolClass = require('../src/models/SchoolClass');
const StudentEnrollment = require('../src/models/StudentEnrollment');
const AcademicSession = require('../src/models/AcademicSession');
const Admission = require('../src/models/Admission');
const { migrate } = require('../src/scripts/migrate');
const { currentAcademicYear } = require('../src/utils/dates');

let A;
let B;

beforeAll(connect);
afterAll(disconnect);
beforeEach(async () => {
  await clear();
  A = await seedSchool('Alpha School');
  B = await seedSchool('Beta School');
});

const newStudent = (extra = {}) => ({ name: 'Kabir', email: `kabir${Date.now()}${Math.random()}@test.local`, phone: '9000000011', class: '10', section: 'A', ...extra });

describe('academic sessions', () => {
  test('the first session becomes current; names and dates are validated; overlaps are refused', async () => {
    const bad = await api().post('/api/academic/sessions').set(auth(A.admin)).send({ name: '2026-28' });
    expect(bad.status).toBe(400);

    const s1 = await api().post('/api/academic/sessions').set(auth(A.admin)).send({ name: '2026-27' });
    expect(s1.status).toBe(201);
    expect(s1.body.data.status).toBe('current');
    expect(new Date(s1.body.data.startDate).toISOString().slice(0, 10)).toBe('2026-04-01');
    expect(new Date(s1.body.data.endDate).toISOString().slice(0, 10)).toBe('2027-03-31');

    const overlap = await api().post('/api/academic/sessions').set(auth(A.admin)).send({ name: '2027-28', startDate: '2027-03-01', endDate: '2028-02-28' });
    expect(overlap.status).toBe(409);

    const s2 = await api().post('/api/academic/sessions').set(auth(A.admin)).send({ name: '2027-28' });
    expect(s2.body.data.status).toBe('upcoming');
    const made = await api().patch(`/api/academic/sessions/${s2.body.data._id}/current`).set(auth(A.admin));
    expect(made.body.data.status).toBe('current');
    expect((await AcademicSession.findById(s1.body.data._id)).status).toBe('closed');

    const list = await api().get('/api/academic/sessions').set(auth(A.teacherUser));
    expect(list.body.current).toBe('2027-28');
    expect((await api().get('/api/schools/me').set(auth(A.admin))).body.data.academicYear).toBe('2027-28');
    // Other school unaffected
    expect((await api().get('/api/academic/sessions').set(auth(B.admin))).body.data).toEqual([]);
  });

  test('without a session the year is worked out from the date and the school\'s start month', async () => {
    const res = await api().get('/api/academic/settings').set(auth(A.admin));
    expect(res.body.data.currentSession).toBe(currentAcademicYear());
    const saved = await api().put('/api/academic/settings').set(auth(A.admin)).send({ sessionStartMonth: 6, admissionNoPrefix: 'ALP/' });
    expect(saved.body.data.sessionStartMonth).toBe(6);
    expect(saved.body.data.currentSession).toBe(currentAcademicYear(new Date(), 6));
    expect((await api().put('/api/academic/settings').set(auth(A.admin)).send({ sessionStartMonth: 13 })).status).toBe(400);
    expect((await api().put('/api/academic/settings').set(auth(A.teacherUser)).send({ sessionStartMonth: 6 })).status).toBe(403);
  });

  test('new records use the current session: admissions, fees and exams by date', async () => {
    await api().post('/api/academic/sessions').set(auth(A.admin)).send({ name: '2030-31' });
    const enquiry = await api().post('/api/admissions').set(auth(A.admin)).send({ studentName: 'Ira', classApplied: '5', parentName: 'P', parentPhone: '9000000020' });
    expect(enquiry.body.data.academicYear).toBe('2030-31');
    const fee = await api().post('/api/fees/add').set(auth(A.admin)).send({ studentId: A.student._id, amount: 500, dueDate: '2030-07-10' });
    expect(fee.body.data.academicYear).toBe('2030-31');
  });
});

describe('classes, sections and subjects', () => {
  test('admin builds the class list; it orders classes naturally and shows class teachers and counts', async () => {
    for (const body of [
      { name: 'Class 10', sections: ['a', 'B', 'B'], subjects: ['Maths', 'Science', 'Maths'] },
      { name: '2', sections: ['A'] },
      { name: 'LKG', sections: ['A'] },
    ]) {
      const created = await api().post('/api/academic/classes').set(auth(A.admin)).send(body);
      expect({ status: created.status, body: created.body }).toMatchObject({ status: 201 });
    }
    const dup = await api().post('/api/academic/classes').set(auth(A.admin)).send({ name: '10' });
    expect(dup.status).toBe(409);

    const ten = await SchoolClass.findOne({ school: A.school._id, name: '10' });
    const res = await api().put(`/api/academic/classes/${ten._id}`).set(auth(A.admin)).send({
      sections: [{ name: 'A', classTeacher: String(A.teacher._id) }, { name: 'B' }],
    });
    expect(res.status).toBe(200);

    const list = await api().get('/api/academic/classes').set(auth(A.teacherUser));
    expect(list.body.data.map((c) => c.name)).toEqual(['LKG', '2', '10']);
    const tenRow = list.body.data[2];
    expect(tenRow.subjects).toEqual(['Maths', 'Science']);
    expect(tenRow.sections.map((s) => s.name)).toEqual(['A', 'B']);
    expect(tenRow.sections[0].classTeacherName).toBe(A.teacher.name);
    expect(tenRow.sections[0].students).toBe(1);
    expect(tenRow.students).toBe(2);
  });

  test('class teachers must belong to the school and get access to their class', async () => {
    const res = await api().post('/api/academic/classes').set(auth(A.admin)).send({ name: '9', sections: [{ name: 'C', classTeacher: String(B.teacher._id) }] });
    expect(res.status).toBe(400);
    await api().post('/api/academic/classes').set(auth(A.admin)).send({ name: '9', sections: [{ name: 'C', classTeacher: String(A.teacher._id) }] });
    expect((await Teacher.findById(A.teacher._id)).assignedClasses).toContain('9-C');
  });

  test('once the class list exists, students and teachers can only be placed in listed classes', async () => {
    // No list yet: anything goes (old behaviour)
    expect((await api().post('/api/students').set(auth(A.admin)).send(newStudent({ class: '7', section: 'Z' }))).status).toBe(201);

    await api().post('/api/academic/classes').set(auth(A.admin)).send({ name: '10', sections: ['A', 'B'] });
    const wrongSection = await api().post('/api/students').set(auth(A.admin)).send(newStudent({ section: 'D' }));
    expect(wrongSection.status).toBe(400);
    expect(wrongSection.body.message).toMatch(/Section D does not exist in Class 10/);
    expect((await api().post('/api/students').set(auth(A.admin)).send(newStudent({ class: '11' }))).status).toBe(400);
    expect((await api().post('/api/students').set(auth(A.admin)).send(newStudent())).status).toBe(201);

    expect((await api().put(`/api/students/${A.student._id}`).set(auth(A.admin)).send({ section: 'D' })).status).toBe(400);
    expect((await api().patch(`/api/teachers/${A.teacher._id}/assign-class`).set(auth(A.admin)).send({ className: '12', section: 'A' })).status).toBe(400);
    expect((await api().post('/api/bulk/promote').set(auth(A.admin)).send({ fromClass: '10', fromSection: 'A', toClass: '11', toSection: 'A' })).status).toBe(400);

    // Class and section dropdowns now come from the list
    expect((await api().get('/api/students/classes').set(auth(A.admin))).body.data).toEqual(['10']);
    expect((await api().get('/api/students/sections?class=10').set(auth(A.admin))).body.data).toEqual(['A', 'B']);
  });

  test('sections with students cannot be removed, renamed classes keep their students safe', async () => {
    const created = await api().post('/api/academic/classes').set(auth(A.admin)).send({ name: '10', sections: ['A', 'B'] });
    const id = created.body.data._id;
    const remove = await api().put(`/api/academic/classes/${id}`).set(auth(A.admin)).send({ sections: ['B'] });
    expect(remove.status).toBe(409);
    expect((await api().put(`/api/academic/classes/${id}`).set(auth(A.admin)).send({ name: 'X' })).status).toBe(409);
    expect((await api().put(`/api/academic/classes/${id}`).set(auth(A.admin)).send({ isActive: false })).status).toBe(409);
    expect((await api().delete(`/api/academic/classes/${id}`).set(auth(A.admin))).status).toBe(409);

    const empty = await api().post('/api/academic/classes').set(auth(A.admin)).send({ name: '3', sections: ['A'] });
    expect((await api().delete(`/api/academic/classes/${empty.body.data._id}`).set(auth(A.admin))).status).toBe(200);
  });

  test('import builds the class list from existing students', async () => {
    const res = await api().post('/api/academic/classes/import').set(auth(A.admin));
    expect(res.body.data).toEqual({ created: 1, updated: 0 });
    const ten = await SchoolClass.findOne({ school: A.school._id, name: '10' });
    expect(ten.sections.map((s) => s.name)).toEqual(['A', 'B']);
    expect(await SchoolClass.countDocuments({ school: B.school._id })).toBe(0);
    expect((await api().post('/api/academic/classes/import').set(auth(A.admin))).body.data).toEqual({ created: 0, updated: 0 });
  });

  test('only admins manage the class list', async () => {
    expect((await api().post('/api/academic/classes').set(auth(A.teacherUser)).send({ name: '1' })).status).toBe(403);
    expect((await api().get('/api/academic/setup-status').set(auth(A.teacherUser))).status).toBe(403);
  });
});

describe('admission numbers, roll numbers and history', () => {
  test('students get the next admission number (with the school prefix) and roll number automatically', async () => {
    await api().put('/api/academic/settings').set(auth(A.admin)).send({ admissionNoPrefix: 'ALP/' });
    const first = await api().post('/api/students').set(auth(A.admin)).send(newStudent());
    expect(first.status).toBe(201);
    expect(first.body.data.admissionNo).toBe('ALP/1');
    expect(first.body.data.rollNumber).toBe('2'); // Aarav already has roll 1 in 10-A
    expect(first.body.credentials.student.admissionNo).toBe('ALP/1');
    const second = await api().post('/api/students').set(auth(A.admin)).send(newStudent());
    expect(second.body.data.admissionNo).toBe('ALP/2');
    expect(second.body.data.rollNumber).toBe('3');
    // Numbering is per school
    const other = await api().post('/api/students').set(auth(B.admin)).send(newStudent());
    expect(other.body.data.admissionNo).toBe('1');
  });

  test('a given admission number is kept, must be unique in the school, and works as a search term', async () => {
    const res = await api().post('/api/students').set(auth(A.admin)).send(newStudent({ admissionNo: '2019/044' }));
    expect(res.body.data.admissionNo).toBe('2019/044');
    expect((await api().post('/api/students').set(auth(A.admin)).send(newStudent({ admissionNo: '2019/044' }))).status).toBe(409);
    expect((await api().post('/api/students').set(auth(B.admin)).send(newStudent({ admissionNo: '2019/044' }))).status).toBe(201);
    expect((await api().put(`/api/students/${A.student._id}`).set(auth(A.admin)).send({ admissionNo: '2019/044' })).status).toBe(409);

    const found = await api().get('/api/students?search=2019/044').set(auth(A.admin));
    expect(found.body.data.map((s) => s.name)).toEqual(['Kabir']);
  });

  test('history: created, corrected, promoted to the next session and left; earlier years are kept', async () => {
    await api().post('/api/academic/sessions').set(auth(A.admin)).send({ name: '2026-27' });
    const created = await api().post('/api/students').set(auth(A.admin)).send(newStudent({ class: '9', section: 'A' }));
    const id = created.body.data._id;

    await api().put(`/api/students/${id}`).set(auth(A.admin)).send({ section: 'B' }); // correction in the same year
    let history = (await api().get(`/api/students/${id}/history`).set(auth(A.admin))).body.data.history;
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ session: '2026-27', class: '9', section: 'B', status: 'studying' });

    await api().post('/api/academic/sessions').set(auth(A.admin)).send({ name: '2027-28' });
    const promote = await api().post('/api/bulk/promote').set(auth(A.admin)).send({ fromClass: '9', fromSection: 'B', toClass: '10', toSection: 'C', toSession: '2027-28' });
    expect(promote.status).toBe(200);
    history = (await api().get(`/api/students/${id}/history`).set(auth(A.admin))).body.data.history;
    expect(history.map((h) => [h.session, h.class, h.section, h.status])).toEqual([
      ['2027-28', '10', 'C', 'studying'],
      ['2026-27', '9', 'B', 'promoted'],
    ]);

    await api().delete(`/api/students/${id}`).set(auth(A.admin)).send({ reason: 'Moved to another city' });
    const left = await StudentEnrollment.findOne({ student: id, session: '2027-28' });
    expect(left.status).toBe('left');
    expect(left.note).toBe('Moved to another city');

    expect((await api().post('/api/bulk/promote').set(auth(A.admin)).send({ fromClass: '10', fromSection: 'A', toClass: '11', toSection: 'A', toSession: '2099-00' })).status).toBe(400);
    expect((await api().get(`/api/students/${id}/history`).set(auth(B.admin))).status).toBe(404);
  });

  test('admitting from an admission uses the class list sections and assigns numbers automatically', async () => {
    await api().post('/api/academic/classes').set(auth(A.admin)).send({ name: '5', sections: ['B', 'A'] });
    const adm = await Admission.create({ school: A.school._id, applicationNo: 'ADM-1', academicYear: '2026-27', classApplied: '5', studentName: 'Ira', parentName: 'P', parentPhone: '9000000021', status: 'Approved' });
    const defaults = await api().get(`/api/admissions/${adm._id}/admit-defaults`).set(auth(A.admin));
    expect(defaults.body.data).toEqual({ sections: ['A', 'B'], section: 'A', rollNumber: '1' });
    const admitted = await api().post(`/api/admissions/${adm._id}/admit`).set(auth(A.admin)).send({ section: 'A', studentEmail: 'ira@test.local' });
    expect(admitted.status).toBe(201);
    expect(admitted.body.student.admissionNo).toBe('1');
    expect(admitted.body.student.rollNumber).toBe('1');
    expect(await StudentEnrollment.countDocuments({ student: admitted.body.student._id })).toBe(1);
  });

  test('a failed student creation leaves no enrollment behind', async () => {
    await api().post('/api/students').set(auth(A.admin)).send(newStudent({ email: A.studentUser.email }));
    expect(await StudentEnrollment.countDocuments({})).toBe(0);
  });
});

describe('setup checklist', () => {
  test('shows what the school still has to do, including fees when the school has them', async () => {
    let res = await api().get('/api/academic/setup-status').set(auth(A.admin));
    const done = (key) => res.body.data.steps.find((s) => s.key === key).done;
    expect(done('session')).toBe(false);
    expect(done('teachers')).toBe(true);
    expect(done('students')).toBe(true);
    expect(res.body.data.steps.some((s) => s.key === 'fees')).toBe(true);

    await api().post('/api/academic/sessions').set(auth(A.admin)).send({ name: '2026-27' });
    await api().post('/api/academic/classes').set(auth(A.admin)).send({ name: '10', sections: [{ name: 'A', classTeacher: String(A.teacher._id) }], subjects: ['Maths'] });
    res = await api().get('/api/academic/setup-status').set(auth(A.admin));
    expect(done('session')).toBe(true);
    expect(done('classes')).toBe(true);
    expect(done('subjects')).toBe(true);
    expect(done('classTeachers')).toBe(true);
    expect(res.body.data.currentSession).toBe('2026-27');
  });
});

describe('migration', () => {
  test('existing students get admission numbers in joining order and a current-session enrollment; re-run changes nothing', async () => {
    await Student.updateMany({}, { $unset: { admissionNo: 1 } });
    await StudentEnrollment.deleteMany({});
    await migrate({ apply: true, quiet: true });
    const alpha = await Student.find({ school: A.school._id }).sort({ createdAt: 1 });
    expect(alpha.map((s) => s.admissionNo)).toEqual(['1', '2']);
    expect(await StudentEnrollment.countDocuments({ school: A.school._id })).toBe(2);

    const again = await migrate({ apply: true, quiet: true });
    expect(again['students.admission_no_assigned']).toBeUndefined();
    expect(again['enrollments.created_for_current_session']).toBeUndefined();

    // The counter continues after the migrated numbers
    const next = await api().post('/api/students').set(auth(A.admin)).send(newStudent());
    expect(next.body.data.admissionNo).toBe('3');
  });
});
