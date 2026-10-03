const { api, connect, disconnect, clear, auth, seedSchool } = require('./helpers');
const Student = require('../src/models/Student');
const Fee = require('../src/models/Fee');

let A;
let B;

beforeAll(connect);
afterAll(disconnect);
beforeEach(async () => {
  await clear();
  A = await seedSchool('Alpha School');
  B = await seedSchool('Beta School');
  // 10-A already has one student from the seed; add 11 more in 10-A and 4 in 9-A.
  const extra = [];
  for (let i = 0; i < 11; i += 1) extra.push({ name: `A${i}`, rollNumber: String(10 + i), class: '10', section: 'A' });
  for (let i = 0; i < 4; i += 1) extra.push({ name: `N${i}`, rollNumber: String(i + 1), class: '9', section: 'A' });
  await Student.insertMany(extra.map((s) => ({ ...s, phone: '9000000000', school: A.school._id, isActive: true })));
});

test('lists are complete without paging, so existing screens keep working', async () => {
  const res = await api().get('/api/students').set(auth(A.admin));
  expect(res.status).toBe(200);
  expect(res.body.count).toBe(17); // 2 seeded + 15 added
  expect(res.body.pagination).toBeUndefined();
});

test('page and limit return one page with totals; limits are capped', async () => {
  const first = await api().get('/api/students?page=1&limit=5').set(auth(A.admin));
  expect(first.body.data).toHaveLength(5);
  expect(first.body.pagination).toEqual({ page: 1, limit: 5, total: 17, pages: 4 });
  const last = await api().get('/api/students?page=4&limit=5').set(auth(A.admin));
  expect(last.body.data).toHaveLength(2);
  const ids = new Set([...first.body.data, ...last.body.data].map((s) => s._id));
  expect(ids.size).toBe(7);
  const big = await api().get('/api/students?limit=100000').set(auth(A.admin));
  expect(big.body.pagination.limit).toBe(200);
});

test('paging keeps every scope: filters, the teacher\'s classes and the school', async () => {
  const filtered = await api().get('/api/students?class=9&page=1&limit=2').set(auth(A.admin));
  expect(filtered.body.pagination.total).toBe(4);
  const teacher = await api().get('/api/students?page=1&limit=50').set(auth(A.teacherUser)); // teacher of 10-A
  expect(teacher.body.pagination.total).toBe(12);
  expect(teacher.body.data.every((s) => s.class === '10' && s.section === 'A')).toBe(true);
  const other = await api().get('/api/students?page=1&limit=50').set(auth(B.admin));
  expect(other.body.pagination.total).toBe(2);
});

test('paged fee list: summary covers every matching fee, not only the page', async () => {
  const due = new Date('2026-12-01');
  await Fee.insertMany([1000, 2000, 3000].map((amount, i) => ({
    school: A.school._id, studentId: A.student._id, feeType: `Term ${i + 1}`, amount, paidAmount: i === 0 ? 1000 : 0,
    dueDate: due, academicYear: '2026-27', status: i === 0 ? 'Paid' : 'Unpaid',
  })));
  const res = await api().get('/api/fees?page=1&limit=1').set(auth(A.admin));
  expect(res.body.data).toHaveLength(1);
  expect(res.body.pagination.total).toBe(3);
  expect(res.body.summary).toEqual({ total: 6000, totalPaid: 1000, totalDue: 5000 });
});

test('users, parents, library and leave lists accept paging too', async () => {
  for (const path of ['/api/users', '/api/parents', '/api/library', '/api/leaves']) {
    const res = await api().get(`${path}?page=1&limit=1`).set(auth(A.admin));
    expect(res.status).toBe(200);
    expect(res.body.pagination).toMatchObject({ page: 1, limit: 1 });
    expect(res.body.data.length).toBeLessThanOrEqual(1);
  }
});
