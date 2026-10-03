const { api, connect, disconnect, clear, auth, seedSchool } = require('./helpers');
const User = require('../src/models/User');
const School = require('../src/models/School');
const Student = require('../src/models/Student');
const { hashPassword } = require('../src/services/credentials');
const { clearPlanCache } = require('../src/services/subscription');

let A;
let B;
let owner;

beforeAll(connect);
afterAll(disconnect);
beforeEach(async () => {
  await clear();
  clearPlanCache();
  A = await seedSchool('Alpha School');
  B = await seedSchool('Beta School');
  const user = await User.create({ name: 'Owner', email: `owner${Date.now()}@eduamigo.in`, role: 'superadmin', school: null, password: await hashPassword('OwnerPass123') });
  const login = await api().post('/api/platform/login').send({ email: user.email, password: 'OwnerPass123' });
  owner = { Authorization: `Bearer ${login.body.token}` };
  // Alpha: standard plan + transport add-on, 2 active students (from the seed) + 8 more = 10.
  await School.updateOne({ _id: A.school._id }, { 'subscription.plan': 'standard', 'subscription.addOns': ['transport'], 'subscription.status': 'trial' });
  await Student.insertMany(Array.from({ length: 8 }, (_, i) => ({ name: `S${i}`, rollNumber: String(50 + i), class: '8', section: 'A', phone: '9', school: A.school._id, isActive: true })));
});

const YEAR = { from: '2026-04-01', to: '2027-03-31' };

test('nothing to bill until prices are set: clear warnings, no invoice', async () => {
  const preview = await api().get(`/api/platform/schools/${A.school._id}/invoice-preview?from=${YEAR.from}&to=${YEAR.to}`).set(owner);
  expect(preview.status).toBe(200);
  expect(preview.body.data.warnings).toEqual(['Standard plan has no price yet', 'Transport & Live Bus add-on has no price yet']);
  const create = await api().post(`/api/platform/schools/${A.school._id}/invoices`).set(owner).send(YEAR);
  expect(create.status).toBe(400);
});

test('a year: students x plan price + add-on, discount, 18% GST', async () => {
  await api().put('/api/platform/plans/standard').set(owner).send({ pricePerStudentYear: 300 }).expect(200);
  await api().put('/api/platform/addons/transport').set(owner).send({ pricePerStudentYear: 100 }).expect(200);
  await api().patch(`/api/platform/schools/${A.school._id}/subscription`).set(owner).send({ discountPercent: 10 }).expect(200);

  const res = await api().post(`/api/platform/schools/${A.school._id}/invoices`).set(owner).send(YEAR);
  expect(res.status).toBe(201);
  const inv = res.body.data;
  expect(inv.number).toMatch(/^INV-\d{4}-0001$/);
  expect(inv.activeStudents).toBe(10);
  expect(inv.lines.map((l) => [l.kind, l.amount])).toEqual([['plan', 3000], ['addon', 1000], ['discount', -400]]);
  expect(inv).toMatchObject({ subtotal: 3600, taxRate: 18, tax: 648, total: 4248, status: 'draft' });

  const second = await api().post(`/api/platform/schools/${A.school._id}/invoices`).set(owner).send({ from: '2026-04-01', to: '2026-06-30' });
  expect(second.body.data.number).toMatch(/-0002$/);
  expect(second.body.data.lines[0].periodShare).toBeCloseTo(0.25, 1); // a quarter of a year
});

test('issue, pay and void: paying extends the school\'s paid period; the school sees only issued and paid bills', async () => {
  await api().put('/api/platform/plans/standard').set(owner).send({ pricePerStudentYear: 300 }).expect(200);
  const draft = (await api().post(`/api/platform/schools/${A.school._id}/invoices`).set(owner).send(YEAR)).body.data;

  let mine = await api().get('/api/schools/me/invoices').set(auth(A.admin));
  expect(mine.body.data).toHaveLength(0); // drafts are private
  expect((await api().patch(`/api/platform/invoices/${draft._id}`).set(owner).send({ action: 'mark_paid' })).status).toBe(409);

  await api().patch(`/api/platform/invoices/${draft._id}`).set(owner).send({ action: 'issue' }).expect(200);
  mine = await api().get('/api/schools/me/invoices').set(auth(A.admin));
  expect(mine.body.data.map((i) => i.status)).toEqual(['issued']);
  expect((await api().get('/api/schools/me/invoices').set(auth(B.admin))).body.data).toHaveLength(0);
  expect((await api().get('/api/schools/me/invoices').set(auth(A.teacherUser))).status).toBe(403);

  const paid = await api().patch(`/api/platform/invoices/${draft._id}`).set(owner).send({ action: 'mark_paid', paymentRef: 'UTR123' });
  expect(paid.body.data).toMatchObject({ status: 'paid', paymentRef: 'UTR123' });
  const school = await School.findById(A.school._id);
  expect(school.subscription.status).toBe('active');
  expect(school.subscription.currentPeriodEnd.toISOString().slice(0, 10)).toBe('2027-03-31');
  expect((await api().patch(`/api/platform/invoices/${draft._id}`).set(owner).send({ action: 'void' })).status).toBe(409);

  const list = await api().get('/api/platform/invoices?status=paid').set(owner);
  expect(list.body.totals.paid).toEqual({ count: 1, total: 3540 });
});

test('only the platform owner can bill; school tokens are refused', async () => {
  expect((await api().get('/api/platform/invoices').set(auth(A.admin))).status).toBe(403);
  expect((await api().post(`/api/platform/schools/${A.school._id}/invoices`).set(auth(A.admin)).send(YEAR)).status).toBe(403);
  expect((await api().get(`/api/platform/schools/${A.school._id}/invoice-preview?from=bad&to=${YEAR.to}`).set(owner)).status).toBe(400);
});
