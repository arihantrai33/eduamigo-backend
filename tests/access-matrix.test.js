jest.mock('../src/services/ai', () => ({
  embedQuery: jest.fn(async () => [0]),
  streamChat: jest.fn(async () => (async function* g() { yield 'ok'; }())),
}));
jest.mock('../src/services/retrieval', () => ({ searchChunks: jest.fn(async () => []) }));

// Executable access-control specification.
// For each endpoint: which permission it needs. Every role is tried; roles holding the
// permission must NOT get 403, every other role MUST get 403. A new route that is not
// listed here should be added, so the matrix stays the single reviewed contract.
const { api, connect, disconnect, clear, auth, seedSchool, makeUser } = require('./helpers');
const { ROLE_PERMISSIONS } = require('../src/config/permissions');

const ID = '000000000000000000000000';
const ROUTES = [
  ['get', '/api/students', 'students.read'],
  ['post', '/api/students', 'students.manage'],
  ['put', `/api/students/${ID}`, 'students.manage'],
  ['delete', `/api/students/${ID}`, 'students.manage'],
  ['get', '/api/teachers', 'teachers.read'],
  ['post', '/api/teachers', 'teachers.manage'],
  ['patch', `/api/teachers/${ID}/assign-class`, 'teachers.manage'],
  ['get', '/api/parents', 'parents.read'],
  ['post', '/api/parents', 'parents.manage'],
  ['get', '/api/users', 'users.manage'],
  ['post', '/api/users/register', 'users.manage'],
  ['post', `/api/users/${ID}/reset-password`, 'users.manage'],
  ['post', '/api/attendance/bulk', 'attendance.mark'],
  ['get', '/api/attendance/today', 'attendance.reports'],
  ['get', '/api/attendance/report', 'attendance.reports'],
  ['post', '/api/marks/save', 'marks.enter'],
  ['patch', '/api/marks/publish', 'marks.enter'],
  ['get', '/api/exams/results', 'results.read'],
  ['post', '/api/exams', 'exams.manage'],
  ['get', '/api/timetable', 'timetable.manage'],
  ['post', '/api/timetable', 'timetable.manage'],
  ['get', '/api/fees', 'fees.read'],
  ['get', '/api/fee-structures/summary', 'fees.read'],
  ['patch', `/api/fees/${ID}/pay`, 'fees.collect'],
  ['post', '/api/fee-structures', 'fees.structure'],
  ['post', `/api/fee-structures/${ID}/apply`, 'fees.structure'],
  ['get', '/api/hr/salaries', 'hr.manage'],
  ['post', '/api/hr/salaries/generate', 'hr.manage'],
  ['get', '/api/leaves/pending', 'leaves.review'],
  ['get', '/api/leaves', 'leaves.all'],
  ['post', '/api/announcements', 'communication.manage'],
  ['post', '/api/notifications/send', 'communication.manage'],
  ['post', '/api/events', 'communication.manage'],
  ['get', '/api/transport', 'transport.manage'],
  ['post', '/api/transport', 'transport.manage'],
  ['post', '/api/library', 'library.manage'],
  ['post', '/api/bulk/promote', 'bulk.manage'],
  ['post', '/api/bulk/upload/students', 'bulk.manage'],
  ['post', '/api/notes/upload', 'notes.upload'],
  ['post', '/api/schools/subjects', 'settings.manage'],
  ['get', '/api/chat/admin-contacts', 'chat.directory'],
];

// Self-service endpoints: only these roles may call them.
const SELF_SERVICE = [
  ['get', '/api/students/my-profile', ['student']],
  ['get', '/api/parents/my-child', ['parent']],
  ['get', '/api/fees/my', ['student', 'parent']],
  ['get', '/api/attendance/my-summary', ['student']],
  ['get', '/api/attendance/child-summary', ['parent']],
  ['get', '/api/exams/my-results', ['student']],
  ['post', '/api/revision/ask', ['student']],
  ['get', '/api/transport/my-child-bus', ['student', 'parent']],
  ['get', '/api/teachers/me', ['teacher']],
];

const ROLES = ['admin', 'accountant', 'teacher', 'student', 'parent'];
let users;

beforeAll(async () => {
  await connect();
  await clear();
  const s = await seedSchool('Matrix School');
  users = {
    admin: s.admin,
    accountant: await makeUser(s.school, 'accountant'),
    teacher: s.teacherUser,
    student: s.studentUser,
    parent: s.parentUser,
  };
});
afterAll(disconnect);

describe.each(ROUTES)('%s %s requires %s', (method, url, permission) => {
  test.each(ROLES)('%s', async (role) => {
    const res = await api()[method](url).set(auth(users[role])).send({});
    const allowed = ROLE_PERMISSIONS[role].includes(permission);
    if (allowed) expect(res.status).not.toBe(403);
    else expect(res.status).toBe(403);
  });
});

describe.each(SELF_SERVICE)('%s %s is self-service', (method, url, allowedRoles) => {
  test.each(ROLES)('%s', async (role) => {
    const res = await api()[method](url).set(auth(users[role])).send({ question: 'x' });
    if (allowedRoles.includes(role)) expect(res.status).not.toBe(403);
    else expect(res.status).toBe(403);
  });
});

test('accountant sees the school finance but not HR or academics', async () => {
  const profile = await api().get('/api/users/profile').set(auth(users.accountant));
  expect(profile.body.data.permissions).toEqual(expect.arrayContaining(['fees.collect', 'fees.read']));
  expect(profile.body.data.permissions).not.toContain('hr.manage');
});
