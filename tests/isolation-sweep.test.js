// Three-school isolation sweep.
//
// School A is the one acting; B and C are the others. Every route the app mounts is called as each of A's roles (admin,
// teacher, parent, student) with identifiers that belong to B and C, then:
//   1. no response contains an id, name or storage key that belongs to B or C (ids the request itself supplied are ignored),
//   2. no request ends in a server error,
//   3. after every write, B's and C's data is byte-for-byte what it was.
// The list of routes is read from src/app.js and the route files, so a new route is swept without anyone remembering to add it;
// a router that is not mounted in app.js, or not mapped here, fails the test.
jest.setTimeout(600000);
jest.mock('../src/config/firebase', () => ({ db: { ref: () => ({ update: async () => {}, remove: async () => {}, set: async () => {} }) } }));
jest.mock('../src/config/cloudinary', () => ({ uploader: { upload_stream: () => { throw new Error('no network in tests'); }, destroy: async () => ({}) }, url: () => 'https://cdn.test/x' }));
jest.mock('../src/services/ai', () => ({ embedQuery: jest.fn(async () => [0]), streamChat: jest.fn(async () => (async function* g() { yield 'ok'; }())) }));
jest.mock('../src/services/retrieval', () => ({ searchChunks: jest.fn(async () => []) }));

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mongoose = require('mongoose');
const { api, connect, disconnect, clear, auth, seedSchool, scheduleExam } = require('./helpers');

const M = (name) => require(`../src/models/${name}`);
const day = new Date('2026-10-12');
const hex24 = /[a-f0-9]{24}/g;

// ---- routes -------------------------------------------------------------------------------------------------------------

const appSource = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8');
const mounts = [...appSource.matchAll(/app\.use\('(\/api\/[\w-]+)'[^\n]*require\('\.\/routes\/(\w+)'\)/g)].map((m) => ({ prefix: m[1], file: m[2] }));

// Routers that are not part of a school's own API, or that are checked by their own tests.
const SKIP_PREFIX = ['/api/platform', '/api/public'];
// Calls that leave the machine (AI providers) or act on the caller's own account only.
const SKIP_CALL = [
  /^POST \/api\/assistant\/ask/, /^POST \/api\/revision\/ask/,
  /^POST \/api\/users\/(login|forgot-password|reset-password)/,
  /\/driver\//, // token-based driver app routes: no school login at all
];

function routesOf(mount) {
  const router = require(`../src/routes/${mount.file}`);
  const out = [];
  for (const layer of router.stack) {
    if (!layer.route) continue;
    for (const method of Object.keys(layer.route.methods)) {
      const raw = layer.route.path === '/' ? '' : layer.route.path;
      out.push({ method: method.toUpperCase(), template: `${mount.prefix}${raw}`, params: [...raw.matchAll(/:(\w+)/g)].map((m) => m[1]) });
    }
  }
  return out;
}

// What an :id means under each prefix, to pick ids of the right kind.
const ID_MODEL = {
  '/api/students': 'Student', '/api/teachers': 'Teacher', '/api/parents': 'Parent', '/api/fees': 'Fee', '/api/fee-structures': 'FeeStructure',
  '/api/exams': 'ExamSchedule', '/api/marks': 'ExamSchedule', '/api/report-cards': 'Student', '/api/admissions': 'Admission',
  '/api/library': 'Library', '/api/announcements': 'Announcement', '/api/events': 'Event', '/api/leaves': 'LeaveRequest',
  '/api/notifications': 'Notification', '/api/notes': 'Note', '/api/transport': 'Transport', '/api/timetable': 'Timetable',
  '/api/users': 'User', '/api/assistant': 'AssistantTicket', '/api/payments': 'PaymentOrder', '/api/academic': 'SchoolClass',
  '/api/hr': 'Salary', '/api/schools': 'School', '/api/bulk': 'Student', '/api/chat': 'User',
};
const PARAM_MODEL = { studentId: 'Student', childId: 'Student', parentId: 'Parent', teacherId: 'Teacher', feeId: 'Fee', userId: 'User', examId: 'ExamSchedule', receiverId: 'User', classId: 'SchoolClass', sessionId: 'AcademicSession' };

// ---- data ---------------------------------------------------------------------------------------------------------------

let A; let B; let C;
let forbidden; let foreignByModel; let ownByModel;
const tenantModels = () => mongoose.modelNames().map((n) => mongoose.model(n)).filter((m) => m.schema.path('school') && m.modelName !== 'School');

async function seedExtras(ctx, tag) {
  const school = ctx.school._id;
  const mk = async (name, doc) => M(name).create({ school, ...doc });
  const teacher = ctx.teacher._id;
  await Promise.all([
    mk('Announcement', { title: `Notice ${tag}`, message: 'm' }),
    mk('Event', { title: `Event ${tag}`, date: day }),
    mk('Fee', { studentId: ctx.student._id, feeType: 'Tuition', amount: 1000, dueDate: day }),
    mk('FeeStructure', { academicYear: '2026-27', class: '10', feeType: 'Tuition', amount: 1000, dueDate: day }),
    mk('LeaveRequest', { requestedBy: ctx.parentUser._id, role: 'parent', fromDate: day, toDate: day, reason: `Reason ${tag}`, status: 'Approved' }),
    mk('Library', { title: `Book ${tag}`, totalCopies: 2, available: 2 }),
    mk('Salary', { teacher, month: 1, year: 2026, basicSalary: 1000 }),
    mk('SchoolClass', { name: '7', sections: [{ name: 'A' }] }),
    mk('Admission', { applicationNo: `AP-${tag}`, academicYear: '2026-27', classApplied: '5', studentName: `Applicant ${tag}`, parentName: 'P', parentPhone: '9111111111' }),
    mk('Timetable', { class: '10', section: 'A', day: 'Monday', periods: [] }),
    mk('Note', { title: `Note ${tag}`, subject: 'Mathematics', class: '10', section: 'A', uploadedBy: ctx.teacherUser._id }),
    mk('SchoolDocument', { title: `Doc ${tag}`, text: 'Fees are due on the first of the month.' }),
    mk('Transport', { busNumber: `BUS-${tag}`, driverName: 'D', driverPhone: '9', routeName: 'R', driverToken: crypto.randomBytes(8).toString('hex') }),
    mk('Attendance', { studentId: ctx.student._id, date: day, status: 'Absent', class: '10', section: 'A' }),
    scheduleExam(ctx),
  ]);
  await require('../src/services/notify').notifyUser(school, ctx.parentUser._id, { title: `Hello ${tag}`, message: 'm' });
  // Every student has a private photo, so a leak of the storage key would show up anywhere it appears.
  for (const s of await M('Student').find({ school })) await M('Student').updateOne({ _id: s._id, school }, { photoKey: `eduamigo/${school}/students/${crypto.randomBytes(16).toString('hex')}` });
}

async function collectIds() {
  forbidden = new Set([String(B.school._id), String(C.school._id)]);
  foreignByModel = {}; ownByModel = {};
  for (const Model of tenantModels()) {
    const rows = await Model.collection.find({ school: { $in: [A.school._id, B.school._id, C.school._id] } }, { projection: { _id: 1, school: 1 } }).toArray();
    for (const r of rows) {
      const own = String(r.school) === String(A.school._id);
      (own ? ownByModel : foreignByModel)[Model.modelName] ||= [];
      (own ? ownByModel : foreignByModel)[Model.modelName].push(String(r._id));
      if (!own) forbidden.add(String(r._id));
    }
  }
  for (const id of [B.school._id, C.school._id]) { foreignByModel.School ||= []; foreignByModel.School.push(String(id)); }
  ownByModel.School = [String(A.school._id)];
}

// Byte-level fingerprint of everything that belongs to B and C.
async function fingerprint() {
  const hash = crypto.createHash('sha1');
  for (const Model of tenantModels().sort((x, y) => x.modelName.localeCompare(y.modelName))) {
    const rows = await Model.collection.find({ school: { $in: [B.school._id, C.school._id] } }).sort({ _id: 1 }).toArray();
    hash.update(`${Model.modelName}:${rows.length}:${JSON.stringify(rows)}`);
  }
  hash.update(JSON.stringify(await M('School').collection.find({ _id: { $in: [B.school._id, C.school._id] } }).sort({ _id: 1 }).toArray()));
  return hash.digest('hex');
}

beforeAll(async () => {
  await connect();
  [A, B, C] = [await seedSchool('Alpha School'), await seedSchool('Beta School'), await seedSchool('Gamma School')];
  for (const [ctx, tag] of [[A, 'AAA'], [B, 'BBB'], [C, 'CCC']]) await seedExtras(ctx, tag);
  await collectIds();
});
afterAll(disconnect);

// ---- sweep --------------------------------------------------------------------------------------------------------------

const roles = () => ({ admin: auth(A.admin), teacher: auth(A.teacherUser), parent: auth(A.parentUser), student: auth(A.studentUser) });

function fillCandidates(route, prefix) {
  const generic = ['Student', 'Fee', 'User', 'Teacher', 'Announcement', 'Notification', 'Library', 'Transport'].flatMap((m) => (foreignByModel[m] || []).slice(0, 3));
  const perParam = route.params.map((p) => {
    const model = PARAM_MODEL[p] || (p === 'id' ? ID_MODEL[prefix] : null);
    return [...new Set([...(model ? (foreignByModel[model] || []).slice(0, 4) : []), ...generic.slice(0, 3)])];
  });
  if (!route.params.length) return [[]];
  // One foreign id per parameter at a time (the others stay a plausible own id), instead of every combination.
  const own = route.params.map((p) => (ownByModel[PARAM_MODEL[p] || (p === 'id' ? ID_MODEL[prefix] : '')] || [String(A.student._id)])[0]);
  const combos = [];
  perParam.forEach((ids, i) => ids.forEach((id) => combos.push(own.map((o, j) => (i === j ? id : o)))));
  return combos.length ? combos : [own];
}

const urlFor = (route, values) => route.params.reduce((u, p, i) => u.replace(`:${p}`, values[i]), route.template);

function leakIn(text, suppliedText) {
  const supplied = new Set(suppliedText.match(hex24) || []);
  const hits = [...new Set(text.match(hex24) || [])].filter((id) => forbidden.has(id) && !supplied.has(id));
  const problems = hits.map((id) => `foreign id ${id}`);
  if (/Beta School|Gamma School/.test(text)) problems.push('foreign school name');
  if (/photoKey|eduamigo\/[a-f0-9]{24}\/students|cloudinary/i.test(text)) problems.push('storage key or cloud address');
  return problems;
}

describe('route inventory', () => {
  test('every router file is mounted in app.js and mapped here', () => {
    const files = fs.readdirSync(path.join(__dirname, '../src/routes')).map((f) => f.replace('.js', '')).sort();
    expect(mounts.map((m) => m.file).sort()).toEqual(files);
  });
  test('the sweep covers a real number of routes', () => {
    const all = mounts.filter((m) => !SKIP_PREFIX.includes(m.prefix)).flatMap(routesOf);
    expect(all.length).toBeGreaterThan(120);
  });
});

describe('school A cannot reach schools B and C', () => {
  const swept = { get: 0, write: 0, calls: 0 };
  const problems = [];
  const serverErrors = [];

  test('GET: no role sees anything of B or C, whatever id it asks for', async () => {
    const before = await fingerprint();
    for (const mount of mounts.filter((m) => !SKIP_PREFIX.includes(m.prefix))) {
      for (const route of routesOf(mount).filter((r) => r.method === 'GET')) {
        swept.get += 1;
        for (const [role, headers] of Object.entries(roles())) {
          for (const values of fillCandidates(route, mount.prefix)) {
            const url = urlFor(route, values);
            if (SKIP_CALL.some((re) => re.test(`GET ${url}`))) continue;
            const res = await api().get(url).set(headers);
            swept.calls += 1;
            if (res.status >= 500) serverErrors.push(`${role} GET ${url} -> ${res.status} ${(res.body && res.body.message) || ''}`);
            for (const p of leakIn(res.text || '', url)) problems.push(`${role} GET ${url}: ${p}`);
          }
        }
      }
    }
    expect(await fingerprint()).toBe(before);
    expect(problems).toEqual([]);
    expect(serverErrors).toEqual([]);
    expect(swept.get).toBeGreaterThan(50);
  });

  test('POST, PUT, PATCH, DELETE: nothing of B or C changes, whatever id is used', async () => {
    for (const mount of mounts.filter((m) => !SKIP_PREFIX.includes(m.prefix))) {
      for (const route of routesOf(mount).filter((r) => r.method !== 'GET')) {
        swept.write += 1;
        for (const [role, headers] of Object.entries(roles()).filter(([r]) => r === 'admin' || r === 'teacher')) {
          for (const values of fillCandidates(route, mount.prefix)) {
            const url = urlFor(route, values);
            if (SKIP_CALL.some((re) => re.test(`${route.method} ${url}`))) continue;
            const before = await fingerprint();
            const res = await api()[route.method.toLowerCase()](url).set(headers).send({ name: 'Changed', title: 'Changed', status: 'Paid' });
            swept.calls += 1;
            if (res.status >= 500) serverErrors.push(`${role} ${route.method} ${url} -> ${res.status} ${(res.body && res.body.message) || ''}`);
            for (const p of leakIn(res.text || '', url)) problems.push(`${role} ${route.method} ${url}: ${p}`);
            if ((await fingerprint()) !== before) problems.push(`${role} ${route.method} ${url}: changed another school's data`);
          }
        }
      }
    }
    expect(problems).toEqual([]);
    expect(serverErrors).toEqual([]);
    expect(swept.write).toBeGreaterThan(50);
  });

  test('summary', () => {
    console.log(`isolation sweep: ${swept.get} GET routes, ${swept.write} write routes, ${swept.calls} calls`);
  });
});
