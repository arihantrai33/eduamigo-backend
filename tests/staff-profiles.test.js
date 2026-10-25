const { api, connect, disconnect, clear, auth, makeUser, seedSchool } = require('./helpers');
const StaffProfile = require('../src/models/StaffProfile');

let A;
let B;
beforeAll(connect);
afterAll(disconnect);
beforeEach(async () => { await clear(); A = await seedSchool('Alpha'); B = await seedSchool('Beta'); });

describe('non-teaching staff records', () => {
  test('lists office accounts with or without a record, and saves details', async () => {
    const clerk = await makeUser(A.school, 'staff');
    await makeUser(B.school, 'staff');
    let res = await api().get('/api/staff').set(auth(A.admin)).expect(200);
    expect(res.body.data.map((u) => String(u._id))).toEqual([String(clerk._id)]);
    expect(res.body.data[0].profile).toBeNull();
    await api().put(`/api/staff/${clerk._id}`).set(auth(A.admin)).send({ designation: 'Front office', department: 'Admin', employeeId: 'S-01', phone: '9000000000', joiningDate: '2025-04-01' }).expect(200);
    res = await api().get('/api/staff').set(auth(A.admin)).expect(200);
    expect(res.body.data[0].profile).toMatchObject({ designation: 'Front office', employeeId: 'S-01' });
  });

  test('refuses other schools, teachers, bad dates and duplicate employee ids; needs hr access', async () => {
    const clerk = await makeUser(A.school, 'staff');
    const other = await makeUser(A.school, 'staff');
    const foreign = await makeUser(B.school, 'staff');
    await api().put(`/api/staff/${foreign._id}`).set(auth(A.admin)).send({ designation: 'x' }).expect(404);
    await api().put(`/api/staff/${A.teacherUser._id}`).set(auth(A.admin)).send({ designation: 'x' }).expect(404);
    await api().put(`/api/staff/${clerk._id}`).set(auth(A.admin)).send({ joiningDate: 'not a date' }).expect(400);
    await api().put(`/api/staff/${clerk._id}`).set(auth(A.admin)).send({ employeeId: 'S-9' }).expect(200);
    await api().put(`/api/staff/${other._id}`).set(auth(A.admin)).send({ employeeId: 'S-9' }).expect(409);
    await api().get('/api/staff').set(auth(A.teacherUser)).expect(403);
    await api().put(`/api/staff/${clerk._id}`).set(auth(clerk)).send({ designation: 'boss' }).expect(403);
    expect(await StaffProfile.countDocuments({ school: B.school._id })).toBe(0);
  });
});
