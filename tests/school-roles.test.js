// Configurable roles. A school's roles are data (SchoolRole), seeded from the old code table so nobody's access changes, extended
// with templates and custom roles, assigned on top of a person's own role, and always resolved on the server for every request.
const { api, connect, disconnect, clear, auth, makeUser, seedSchool } = require('./helpers');
const SchoolRole = require('../src/models/SchoolRole');
const User = require('../src/models/User');
const Fee = require('../src/models/Fee');
const AuditLog = require('../src/models/AuditLog');
const { PERMISSIONS, ROLE_PERMISSIONS, ROLE_SCOPE } = require('../src/config/permissions');
const { ROLE_TEMPLATES } = require('../src/config/roleTemplates');
const roles = require('../src/services/roles');

let A;
let B;
beforeAll(connect);
afterAll(disconnect);
beforeEach(async () => {
  await clear();
  A = await seedSchool('Alpha School');
  B = await seedSchool('Beta School');
});

const get = (u, p) => api().get(p).set(auth(u));
const post = (u, p, b) => api().post(p).set(auth(u)).send(b);
const put = (u, p, b) => api().put(p).set(auth(u)).send(b);
const patch = (u, p, b) => api().patch(p).set(auth(u)).send(b);
const del = (u, p) => api().delete(p).set(auth(u));

const makeRole = async (admin, body) => {
  const res = await post(admin, '/api/roles', body);
  expect([201, 200]).toContain(res.status);
  return res.body.data;
};
const staff = (school, extra = {}) => makeUser(school, 'staff', extra);
const assign = (actor, user, roleIds) => put(actor, `/api/users/${user._id}/roles`, { roleIds });
const feeFor = (ctx) => Fee.create({ school: ctx.school._id, studentId: ctx.student._id, feeType: 'Tuition', amount: 5000, dueDate: new Date(), academicYear: '2026-27' });
const pay = (u, fee) => patch(u, `/api/fees/${fee._id}/pay`, { amount: 100 });

describe('the built-in roles, now data', () => {
  test('seeding creates admin, accountant and teacher with exactly the old permissions and scopes, and is repeatable', async () => {
    await roles.ensureSystemRoles(A.school._id);
    await roles.ensureSystemRoles(A.school._id);
    const docs = await SchoolRole.find({ school: A.school._id });
    expect(docs.map((d) => d.key).sort()).toEqual(['accountant', 'admin', 'teacher']);
    for (const d of docs) {
      expect(d.isSystem).toBe(true);
      expect([...d.permissions].sort()).toEqual([...ROLE_PERMISSIONS[d.key]].sort());
      expect(Object.fromEntries(d.scopes)).toEqual(ROLE_SCOPE[d.key]);
    }
  });

  test('resolving a user gives the same answer with the seeded roles as without them (parity), for every role', async () => {
    const accountant = await makeUser(A.school, 'accountant');
    const people = { admin: A.admin, accountant, teacher: A.teacherUser };
    const before = {};
    for (const [k, u] of Object.entries(people)) before[k] = await roles.resolveAuthz(u);
    await roles.ensureSystemRoles(A.school._id);
    for (const [k, u] of Object.entries(people)) {
      const after = await roles.resolveAuthz(u);
      expect([...after.permissions].sort()).toEqual([...before[k].permissions].sort());
      expect(after.scopes).toEqual(before[k].scopes);
      expect([...after.permissions].sort()).toEqual([...ROLE_PERMISSIONS[k]].sort());
    }
  });
});

describe('reading roles', () => {
  test('the office sees its roles, the templates, the permission catalogue and the scope families; nobody else does', async () => {
    const res = await get(A.admin, '/api/roles');
    expect(res.status).toBe(200);
    expect(res.body.data.roles.map((r) => r.key).sort()).toEqual(['accountant', 'admin', 'teacher']);
    expect(res.body.data.templates.map((t) => t.key)).toEqual(ROLE_TEMPLATES.map((t) => t.key));
    expect(res.body.data.permissions.map((p) => p.key).sort()).toEqual(Object.keys(PERMISSIONS).sort());
    expect(Object.keys(res.body.data.scopeFamilies)).toEqual(['students', 'academic', 'leaves', 'notes']);
    for (const u of [A.teacherUser, A.parentUser, A.studentUser, await makeUser(A.school, 'accountant')]) {
      expect((await get(u, '/api/roles')).status).toBe(403);
    }
    expect((await api().get('/api/roles')).status).toBe(401);
  });
});

describe('creating and changing roles', () => {
  test('from a template: its permissions and scopes are copied; the role belongs to this school only', async () => {
    const r = await makeRole(A.admin, { name: 'Fee clerk', templateKey: 'fee_collector', description: 'Counter' });
    expect(r).toMatchObject({ name: 'Fee clerk', templateKey: 'fee_collector', isSystem: false, isActive: true });
    expect([...r.permissions].sort()).toEqual(['fees.collect', 'fees.read', 'students.read']);
    expect(r.scopes).toEqual({ students: 'school' });
    const mine = (await get(A.admin, '/api/roles')).body.data.roles.map((x) => x.name);
    const theirs = (await get(B.admin, '/api/roles')).body.data.roles.map((x) => x.name);
    expect(mine).toContain('Fee clerk');
    expect(theirs).not.toContain('Fee clerk');
  });

  test('a minimal role with chosen permissions', async () => {
    const r = await makeRole(A.admin, { name: 'Notice writer', permissions: ['communication.manage'] });
    expect(r.permissions).toEqual(['communication.manage']);
    expect(r.templateKey).toBe('');
  });

  test.each([
    ['no name', { permissions: ['students.read'] }],
    ['a name that is too short', { name: 'x', permissions: ['students.read'] }],
    ['an unknown permission', { name: 'Odd', permissions: ['students.teleport'] }],
    ['an unknown template', { name: 'Odd', templateKey: 'emperor' }],
    ['a scope that does not exist', { name: 'Odd', permissions: ['students.read'], scopes: { students: 'galaxy' } }],
    ['a scope family that does not exist', { name: 'Odd', permissions: ['students.read'], scopes: { payroll: 'school' } }],
    ['permissions that are not a list', { name: 'Odd', permissions: 'students.read' }],
    ['no permissions at all and no template', { name: 'Empty role' }],
  ])('refuses %s', async (_n, body) => {
    const res = await post(A.admin, '/api/roles', body);
    expect(res.status).toBe(400);
    expect(await SchoolRole.countDocuments({ school: A.school._id, isSystem: false })).toBe(0);
  });

  test('the same name twice in a school is refused; another school may use it', async () => {
    await makeRole(A.admin, { name: 'Librarian', templateKey: 'librarian' });
    expect((await post(A.admin, '/api/roles', { name: 'librarian', templateKey: 'librarian' })).status).toBe(409);
    expect((await post(B.admin, '/api/roles', { name: 'Librarian', templateKey: 'librarian' })).status).toBe(201);
  });

  test('edit, preview before saving, deactivate and delete; the built-in roles cannot be changed', async () => {
    const r = await makeRole(A.admin, { name: 'Front desk', templateKey: 'receptionist' });
    const clerk = await staff(A.school);
    expect((await assign(A.admin, clerk, [r._id])).status).toBe(200);
    const preview = await post(A.admin, `/api/roles/${r._id}/preview`, { permissions: ['students.read', 'fees.collect'] });
    expect(preview.status).toBe(200);
    expect(preview.body.data).toMatchObject({ added: ['fees.collect'], removed: ['admissions.manage', 'parents.read'], affectedUsers: 1 });
    expect((await SchoolRole.findById(r._id)).permissions).toContain('admissions.manage'); // a preview saves nothing
    const edited = await patch(A.admin, `/api/roles/${r._id}`, { permissions: ['students.read', 'fees.collect'], name: 'Front desk & fees' });
    expect(edited.status).toBe(200);
    expect(edited.body.data.permissions.sort()).toEqual(['fees.collect', 'students.read']);

    const system = await SchoolRole.findOne({ school: A.school._id, key: 'teacher' }) || (await roles.ensureSystemRoles(A.school._id), await SchoolRole.findOne({ school: A.school._id, key: 'teacher' }));
    expect((await patch(A.admin, `/api/roles/${system._id}`, { permissions: ['students.read'] })).status).toBe(403);
    expect((await del(A.admin, `/api/roles/${system._id}`)).status).toBe(403);
    expect((await del(A.admin, `/api/roles/${r._id}`)).status).toBe(409); // still assigned
    await assign(A.admin, clerk, []);
    expect((await del(A.admin, `/api/roles/${r._id}`)).status).toBe(200);
    expect(await SchoolRole.exists({ _id: r._id })).toBeNull();
  });
});

describe('what a role gives, enforced by the server on every request', () => {
  test('a staff account with a fee-collector role collects fees and reads students, but cannot change fee structures or see payroll', async () => {
    const fee = await feeFor(A);
    const r = await makeRole(A.admin, { name: 'Fee clerk', templateKey: 'fee_collector' });
    const clerk = await staff(A.school);
    expect((await pay(clerk, fee)).status).toBe(403); // no role yet
    expect((await assign(A.admin, clerk, [r._id])).status).toBe(200);
    expect((await pay(clerk, fee)).status).toBe(200);
    expect((await get(clerk, '/api/students')).body.data).toHaveLength(2);
    expect((await post(clerk, '/api/fee-structures', {})).status).toBe(403);
    expect((await get(clerk, '/api/hr/salaries')).status).toBe(403);
    expect((await get(clerk, '/api/users')).status).toBe(403);
  });

  test('taking the role away takes effect on the very next request, with the same token', async () => {
    const fee = await feeFor(A);
    const r = await makeRole(A.admin, { name: 'Fee clerk', templateKey: 'fee_collector' });
    const clerk = await staff(A.school);
    await assign(A.admin, clerk, [r._id]);
    const headers = auth(clerk);
    expect((await api().patch(`/api/fees/${fee._id}/pay`).set(headers).send({ amount: 100 })).status).toBe(200);
    await assign(A.admin, clerk, []);
    expect((await api().patch(`/api/fees/${fee._id}/pay`).set(headers).send({ amount: 100 })).status).toBe(403);
  });

  test('deactivating a role switches it off for everyone who has it, at once', async () => {
    const fee = await feeFor(A);
    const r = await makeRole(A.admin, { name: 'Fee clerk', templateKey: 'fee_collector' });
    const clerk = await staff(A.school);
    await assign(A.admin, clerk, [r._id]);
    expect((await pay(clerk, fee)).status).toBe(200);
    expect((await patch(A.admin, `/api/roles/${r._id}`, { isActive: false })).status).toBe(200);
    expect((await pay(clerk, fee)).status).toBe(403);
    await patch(A.admin, `/api/roles/${r._id}`, { isActive: true });
    expect((await pay(clerk, fee)).status).toBe(200);
  });

  test('a teacher can hold an extra role: the extra permission is added, their own class limits stay', async () => {
    const fee = await feeFor(A);
    const r = await makeRole(A.admin, { name: 'Fee clerk', templateKey: 'fee_collector' });
    expect((await pay(A.teacherUser, fee)).status).toBe(403);
    await assign(A.admin, A.teacherUser, [r._id]);
    expect((await pay(A.teacherUser, fee)).status).toBe(200);
    // still a teacher of class 10-A only: the extra role's school-wide students scope widens the directory (widest wins) ...
    expect((await get(A.teacherUser, '/api/students')).body.data).toHaveLength(2);
    // ... but not attendance marking, which that role does not grant
    const today = new Date().toISOString().slice(0, 10);
    const markB = await post(A.teacherUser, '/api/attendance/bulk', { date: today, class: '10', section: 'B', records: [{ studentId: String(A.otherStudent._id), status: 'Present' }] });
    expect(markB.status).toBe(403);
  });

  test('a role that gives a permission but no scope for the data reaches nothing (fail closed)', async () => {
    const r = await makeRole(A.admin, { name: 'Directory reader', permissions: ['students.read'] });
    const person = await staff(A.school);
    await assign(A.admin, person, [r._id]);
    expect((await get(person, '/api/students')).status).toBe(403);
    await patch(A.admin, `/api/roles/${r._id}`, { scopes: { students: 'school' } });
    expect((await get(person, '/api/students')).status).toBe(200);
  });

  test('a principal template reads school reports but cannot collect fees or change settings', async () => {
    const r = await makeRole(A.admin, { name: 'Principal', templateKey: 'principal' });
    const p = await staff(A.school);
    await assign(A.admin, p, [r._id]);
    expect((await get(p, '/api/attendance/today')).status).toBe(200);
    expect((await get(p, '/api/students')).status).toBe(200);
    expect((await patch(p, `/api/fees/${(await feeFor(A))._id}/pay`, { amount: 1 })).status).toBe(403);
    expect((await get(p, '/api/users')).status).toBe(403);
  });

  test('login tells the apps what the person may do, from the same resolution', async () => {
    const r = await makeRole(A.admin, { name: 'Fee clerk', templateKey: 'fee_collector' });
    const clerk = await staff(A.school, { password: 'Staff#Pass123' });
    await assign(A.admin, clerk, [r._id]);
    const login = await api().post('/api/users/login').send({ identifier: clerk.email, password: 'Staff#Pass123' });
    expect(login.status).toBe(200);
    expect(login.body.user.role).toBe('staff');
    expect(login.body.user.permissions.sort()).toEqual(['fees.collect', 'fees.read', 'students.read']);
  });
});

describe('another school', () => {
  test('its roles cannot be seen, changed, deleted or assigned from here', async () => {
    const theirs = await makeRole(B.admin, { name: 'Their role', templateKey: 'librarian' });
    const mine = await staff(A.school);
    expect((await patch(A.admin, `/api/roles/${theirs._id}`, { name: 'Hijacked' })).status).toBe(404);
    expect((await del(A.admin, `/api/roles/${theirs._id}`)).status).toBe(404);
    expect((await post(A.admin, `/api/roles/${theirs._id}/preview`, { permissions: [] })).status).toBe(404);
    expect((await assign(A.admin, mine, [theirs._id])).status).toBe(400);
    expect((await User.findById(mine._id)).extraRoles || []).toHaveLength(0);
    expect((await SchoolRole.findById(theirs._id)).name).toBe('Their role');
  });

  test('a role of another school in a person\'s list gives nothing, even if it got there some other way', async () => {
    const theirs = await makeRole(B.admin, { name: 'Their fee clerk', templateKey: 'fee_collector' });
    const fee = await feeFor(A);
    const person = await staff(A.school);
    await User.updateOne({ _id: person._id }, { $set: { extraRoles: [theirs._id] } });
    expect((await pay(person, fee)).status).toBe(403);
  });

  test('people of another school cannot be given roles', async () => {
    const r = await makeRole(A.admin, { name: 'Fee clerk', templateKey: 'fee_collector' });
    const outsider = await staff(B.school);
    expect((await assign(A.admin, outsider, [r._id])).status).toBe(404);
  });
});

describe('who may change roles, and how far', () => {
  const roleManager = async () => {
    const r = await makeRole(A.admin, { name: 'Role manager', permissions: ['roles.view', 'roles.manage', 'students.read', 'fees.read', 'fees.collect'], scopes: { students: 'school' } });
    const person = await staff(A.school);
    await assign(A.admin, person, [r._id]);
    return { person, role: r };
  };

  test('a delegate cannot give away a permission they do not hold', async () => {
    const { person } = await roleManager();
    const tooMuch = await post(person, '/api/roles', { name: 'Payroll', permissions: ['hr.manage'] });
    expect(tooMuch.status).toBe(403);
    expect((await post(person, '/api/roles', { name: 'Collector', permissions: ['fees.collect'] })).status).toBe(201);
  });

  test('nor a scope wider than their own', async () => {
    const r = await makeRole(A.admin, { name: 'Class lead', permissions: ['roles.view', 'roles.manage', 'students.read'], scopes: { students: 'assigned' } });
    const person = await staff(A.school);
    await assign(A.admin, person, [r._id]);
    expect((await post(person, '/api/roles', { name: 'Everyone', permissions: ['students.read'], scopes: { students: 'school' } })).status).toBe(403);
    expect((await post(person, '/api/roles', { name: 'Mine', permissions: ['students.read'], scopes: { students: 'assigned' } })).status).toBe(201);
  });

  test('nobody changes their own roles, or edits a role they hold', async () => {
    const { person, role } = await roleManager();
    const other = await makeRole(A.admin, { name: 'Librarian', templateKey: 'librarian' });
    expect((await assign(person, person, [role._id, other._id])).status).toBe(403);
    expect((await patch(person, `/api/roles/${role._id}`, { permissions: [...role.permissions, 'hr.manage'] })).status).toBe(403);
    expect((await del(person, `/api/roles/${role._id}`)).status).toBe(403);
    expect((await User.findById(person._id)).extraRoles.map(String)).toEqual([String(role._id)]);
  });

  test('a delegate cannot hand someone a role with permissions beyond their own', async () => {
    const { person } = await roleManager();
    const payroll = await makeRole(A.admin, { name: 'Payroll', templateKey: 'hr_officer' });
    const target = await staff(A.school);
    expect((await assign(person, target, [payroll._id])).status).toBe(403);
    const collector = await makeRole(A.admin, { name: 'Fee clerk', templateKey: 'fee_collector' });
    expect((await assign(person, target, [collector._id])).status).toBe(200);
  });

  test('the full administrator role cannot be handed out as an extra role, and only a full administrator creates administrators', async () => {
    await roles.ensureSystemRoles(A.school._id);
    const adminRole = await SchoolRole.findOne({ school: A.school._id, key: 'admin' });
    const target = await staff(A.school);
    expect((await assign(A.admin, target, [adminRole._id])).status).toBe(400);
    const { person } = await roleManager();
    await post(A.admin, '/api/roles', { name: 'User admin', permissions: ['users.manage'] });
    expect((await post(person, '/api/users/register', { name: 'Eve', email: 'eve@alpha.test', role: 'admin' })).status).toBe(403);
    expect((await post(A.admin, '/api/users/register', { name: 'Second Admin', email: 'second@alpha.test', role: 'admin' })).status).toBe(201);
  });

  test('only staff accounts take roles: not students, parents or the platform owner', async () => {
    const r = await makeRole(A.admin, { name: 'Fee clerk', templateKey: 'fee_collector' });
    for (const u of [A.studentUser, A.parentUser]) expect((await assign(A.admin, u, [r._id])).status).toBe(400);
    expect((await assign(A.admin, A.admin, [r._id])).status).toBe(403); // yourself
  });

  test('with two administrators one may deactivate the other, nobody deactivates themselves', async () => {
    const second = await makeUser(A.school, 'admin');
    expect((await patch(second, `/api/users/${A.admin._id}/toggle`, {})).status).toBe(200);
    expect((await User.findById(A.admin._id)).isActive).toBe(false);
    expect((await patch(second, `/api/users/${second._id}/toggle`, {})).status).toBe(400);
  });

  test('deactivating the only active administrator is refused even by someone else with user management', async () => {
    const r = await makeRole(A.admin, { name: 'User manager', permissions: ['users.manage'] });
    const manager = await staff(A.school);
    await assign(A.admin, manager, [r._id]);
    const res = await patch(manager, `/api/users/${A.admin._id}/toggle`, {});
    expect(res.status).toBe(409);
    expect((await User.findById(A.admin._id)).isActive).toBe(true);
  });
});

describe('audit', () => {
  test('every change to roles and assignments is recorded with who, what and where', async () => {
    const r = await makeRole(A.admin, { name: 'Fee clerk', templateKey: 'fee_collector' });
    const clerk = await staff(A.school);
    await assign(A.admin, clerk, [r._id]);
    await patch(A.admin, `/api/roles/${r._id}`, { permissions: ['fees.read', 'students.read'] });
    await assign(A.admin, clerk, []);
    await del(A.admin, `/api/roles/${r._id}`);
    const entries = await AuditLog.find({ school: A.school._id, action: /^(role|user\.roles)/ }).sort({ createdAt: 1 });
    expect(entries.map((e) => e.action)).toEqual(['role.created', 'user.roles_changed', 'role.updated', 'user.roles_changed', 'role.deleted']);
    expect(entries[0]).toMatchObject({ actor: A.admin._id, actorRole: 'admin', targetType: 'role' });
    expect(entries[2].details).toMatchObject({ removed: ['fees.collect'] });
    expect(entries[1].details).toMatchObject({ added: [String(r._id)] });
    expect(await AuditLog.countDocuments({ school: B.school._id })).toBe(0);
  });
});

describe('onboarding by school size', () => {
  test('no size chosen: no recommendations; a size gives templates and marks the ones already made', async () => {
    const none = await api().get('/api/roles/recommendations').set(auth(A.admin)).expect(200);
    expect(none.body.data.templates).toEqual([]);
    await api().put('/api/schools/me').set(auth(A.admin)).send({ size: 'small' }).expect(200);
    const small = await api().get('/api/roles/recommendations').set(auth(A.admin)).expect(200);
    expect(small.body.data.templates.map((t) => t.key)).toEqual(['office_manager', 'fee_collector']);
    expect(small.body.data.templates.every((t) => t.created === false)).toBe(true);
    await api().post('/api/roles').set(auth(A.admin)).send({ name: 'Cashier', templateKey: 'fee_collector' }).expect(201);
    const again = await api().get('/api/roles/recommendations').set(auth(A.admin)).expect(200);
    expect(again.body.data.templates.find((t) => t.key === 'fee_collector').created).toBe(true);
    await api().put('/api/schools/me').set(auth(A.admin)).send({ size: 'large' }).expect(200);
    const large = await api().get('/api/roles/recommendations').set(auth(A.admin)).expect(200);
    expect(large.body.data.templates.length).toBeGreaterThan(small.body.data.templates.length);
  });

  test('every recommended template exists, and a bad size is refused', async () => {
    const { PROFILES } = require('../src/config/onboardingProfiles');
    for (const p of Object.values(PROFILES)) for (const key of p.templates) expect(ROLE_TEMPLATES.some((t) => t.key === key)).toBe(true);
    await api().put('/api/schools/me').set(auth(A.admin)).send({ size: 'huge' }).expect(400);
  });

  test('recommendations are per school and need role access', async () => {
    await api().put('/api/schools/me').set(auth(A.admin)).send({ size: 'medium' }).expect(200);
    const b = await api().get('/api/roles/recommendations').set(auth(B.admin)).expect(200);
    expect(b.body.data.size).toBe('');
    await api().get('/api/roles/recommendations').set(auth(A.teacherUser)).expect(403);
  });

  test('the staff-access setup step is optional: a one-person office can still be complete', async () => {
    const res = await api().get('/api/academic/setup-status').set(auth(A.admin)).expect(200);
    const step = res.body.data.steps.find((s) => s.key === 'staffAccess');
    expect(step.optional).toBe(true);
    expect(res.body.data.total).toBe(res.body.data.steps.filter((s) => !s.optional).length);
  });
});
