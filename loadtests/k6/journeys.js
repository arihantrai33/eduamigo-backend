// Realistic role journeys for the staged load test (see loadtests/README.md). Run through `node loadtests/stage.js --stage A`, which
// starts a throwaway database and server, seeds them and passes the settings below. Every request here is an endpoint the website
// itself calls. Each virtual user signs in once (like a real person) and then repeats its role's journey with think time.
//
// Settings (environment): BASE_URL, SEED_FILE, VUS, HOLD, RAMP, COOL, MIX="student:40,parent:25,teacher:20,admin:15", THINK_MIN, THINK_MAX
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Counter } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://localhost:8100';
const seed = JSON.parse(open(__ENV.SEED_FILE || '../data/stage-seed.json'));
const VUS = Number(__ENV.VUS || 10);
const THINK = [Number(__ENV.THINK_MIN || 2), Number(__ENV.THINK_MAX || 6)];
const RUN = __ENV.RUN_ID || 'run';
const PROBE = Number(__ENV.PROBE_RATE || 0.04);   // share of iterations that also ask for another school's record

// ---- traffic mix -> which role a virtual user plays
const mix = (__ENV.MIX || 'student:40,parent:25,teacher:20,admin:15').split(',').map((p) => p.split(':')).map(([role, n]) => ({ role, n: Number(n) }));
const total = mix.reduce((t, m) => t + m.n, 0);
// A repeating pattern in which the roles are spread out (smooth weighted round robin), so even the first 10 users already hold every role
// in roughly the right proportion; user 1..N are not all students.
const pattern = (() => {
  const given = mix.map((m) => ({ role: m.role, n: m.n, seen: 0 })); const out = [];
  for (let i = 0; i < total; i += 1) {
    given.sort((x, y) => ((y.n * (i + 1)) / total - y.seen) - ((x.n * (i + 1)) / total - x.seen));
    given[0].seen += 1; out.push(given[0].role);
  }
  return out;
})();
const perRole = {}; const slot = pattern.map((r) => { perRole[r] = (perRole[r] || 0); return perRole[r]++; });
function roleOf(vu) {
  const i = (vu - 1) % total;
  return { role: pattern[i], seq: Math.floor((vu - 1) / total) * perRole[pattern[i]] + slot[i] };
}

// ---- accounts, spread over the schools in turn
const schools = seed.schools;
const spread = (pick) => { const out = []; const most = Math.max(...schools.map((s) => pick(s).length)); for (let i = 0; i < most; i += 1) for (const s of schools) if (pick(s)[i]) out.push({ s, item: pick(s)[i] }); return out; };
const accounts = {
  student: spread((s) => s.students).map(({ s, item }) => ({ code: s.code, school: s, id: item.admissionNo, student: item })),
  parent: spread((s) => s.students).map(({ s, item }) => ({ code: s.code, school: s, id: item.parentMobile, student: item })),
  teacher: spread((s) => s.teachers).map(({ s, item }) => ({ code: s.code, school: s, id: item.identifier, teacher: item })),
  admin: schools.map((s) => ({ code: s.code, school: s, id: s.admin.identifier })),
};

// ---- measures
const serverError = new Rate('server_error');            // HTTP 5xx or no answer at all
const tenantLeak = new Counter('tenant_leaks');          // another school's record answered 200: must stay 0
const signedIn = new Counter('signed_in_users');
const writes = new Counter('writes_done');
const named = (name) => ({ tags: { name } });

// ---- options
const hold = __ENV.HOLD || '2m';
const ramp = __ENV.RAMP || '30s';
const cool = __ENV.COOL || '30s';
export const options = {
  scenarios: { users: { executor: 'ramping-vus', startVUs: 0, stages: [{ duration: ramp, target: VUS }, { duration: hold, target: VUS }, { duration: cool, target: 0 }], gracefulRampDown: '20s', gracefulStop: '30s' } },
  thresholds: {
    http_req_duration: ['p(95)<500', 'p(99)<1000'],
    http_req_failed: ['rate<0.01'],
    checks: ['rate>0.99'],
    // The three below stop the run: sustained server errors, or one record seen across schools.
    server_error: [{ threshold: 'rate<0.05', abortOnFail: true, delayAbortEval: '30s' }],
    tenant_leaks: [{ threshold: 'count==0', abortOnFail: true }],
  },
  summaryTrendStats: ['count', 'avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  setupTimeout: '120s',
};

// One always-passing threshold per endpoint name makes k6 keep separate latency and error figures for it.
const NAMES = ['login', 'homework create', 'student: profile', 'student: attendance', 'student: timetable', 'student: results', 'student: notifications', 'student: notices', 'student: homework', 'student: fees', 'student: mark homework done', 'tenant probe (student)',
  'parent: children', 'parent: attendance', 'parent: fees', 'parent: notifications', 'parent: notices', 'parent: homework', 'parent: events', 'tenant probe (parent)',
  'teacher: profile', 'teacher: timetable', 'teacher: class attendance', 'teacher: pending leaves', 'teacher: unread chat', 'teacher: notifications', 'teacher: save attendance',
  'office: dashboard', 'office: students', 'office: fees', 'office: pending fees', 'office: notices', 'office: setup status', 'tenant probe (office)', 'office: post notice',
  'student: unread chat', 'parent: chat inbox', 'parent: unread chat', 'parent: chat teachers', 'parent: send message', 'parent: read messages', 'teacher: chat inbox', 'teacher: chat contacts', 'office: record fee payment'];
for (const n of NAMES) { options.thresholds[`http_req_duration{name:${n}}`] = ['max>=0']; options.thresholds[`http_req_failed{name:${n}}`] = ['rate>=0']; }

// ---- helpers
const JSON_H = { 'Content-Type': 'application/json' };
const think = () => sleep(THINK[0] + Math.random() * (THINK[1] - THINK[0]));
const today = () => new Date().toISOString().slice(0, 10);
const weekday = () => new Date().toLocaleDateString('en-US', { weekday: 'long' });
const pick = (list) => list[Math.floor(Math.random() * list.length)];

function get(path, token, name, okStatuses) {
  const p = { headers: { Authorization: `Bearer ${token}` }, tags: { name } };
  if (okStatuses) p.responseCallback = http.expectedStatuses(...okStatuses);
  const res = http.get(`${BASE}${path}`, p);
  serverError.add(res.status === 0 || res.status >= 500);
  check(res, { [`${name} ${okStatuses ? okStatuses.join('/') : 200}`]: (r) => (okStatuses || [200]).includes(r.status) });
  return res;
}
function send(method, path, body, token, name) {
  const res = http.request(method, `${BASE}${path}`, JSON.stringify(body), { headers: { ...JSON_H, Authorization: `Bearer ${token}` }, tags: { name } });
  serverError.add(res.status === 0 || res.status >= 500);
  check(res, { [`${name} saved`]: (r) => r.status === 200 || r.status === 201 });
  return res;
}
// A foreign-school probe is a leak only if the answer carries records. An empty list or an empty object is the school filter doing its job
// (it would be tidier as a 404, but nothing of the other school is exposed).
const carriesData = (res) => {
  if (res.status !== 200) return false;
  let d; try { d = res.json().data; } catch (e) { return true; } // an answer that is not JSON is not understood: treat as a finding
  if (d === undefined || d === null) return false;
  return Array.isArray(d) ? d.length > 0 : typeof d === 'object' ? Object.keys(d).length > 0 : true;
};
// A foreign-school probe that does carry data is recorded with the address and the start of the answer, so it can be judged (real data, or an empty list).
const leak = (res) => { tenantLeak.add(1); console.log(`LEAK ${JSON.stringify({ url: res.url.replace(BASE, ''), body: String(res.body).slice(0, 400) })}`); };
const bodyOf = (res) => { try { return res.json(); } catch (e) { return {}; } };

function signIn(acc) {
  const res = http.post(`${BASE}/api/users/login`, JSON.stringify({ schoolCode: acc.code, identifier: acc.id, password: seed.password }), { headers: JSON_H, tags: { name: 'login' } });
  serverError.add(res.status === 0 || res.status >= 500);
  const ok = check(res, { 'login 200': (r) => r.status === 200, 'login gives a token': (r) => !!bodyOf(r).token });
  if (ok) signedIn.add(1);
  return ok ? bodyOf(res).token : null;
}

// ---- setup: one homework per school (by that school's first teacher), so students have something to mark done
export function setup() {
  const due = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
  return seed.schools.map((s) => {
    const t = s.teachers[0]; const sec = t.sections[0];
    const token = signIn({ code: s.code, id: t.identifier });
    if (!token) return null;
    const res = send('POST', '/api/homework', { title: `LOADTEST ${RUN} practice sheet`, subject: 'Mathematics', class: sec.class, section: sec.section, dueDate: due, audience: 'class' }, token, 'homework create');
    const id = ((bodyOf(res).data) || {})._id;
    if (id) console.log(`CREATED ${JSON.stringify({ collection: 'homeworks', id })}`);
    return id ? { school: s.code, id, class: sec.class, section: sec.section } : null;
  });
}

// ---- journeys
const state = { token: null, me: null, child: null };

function studentJourney(acc, data) {
  const t = state.token;
  get('/api/students/my-profile', t, 'student: profile'); think();
  get('/api/attendance/my-summary', t, 'student: attendance'); think();
  get(`/api/timetable/my?day=${weekday()}`, t, 'student: timetable');
  get('/api/exams/my-results', t, 'student: results'); think();
  get('/api/notifications/my', t, 'student: notifications');
  get('/api/announcements/my', t, 'student: notices'); think();
  const hw = get('/api/homework/my', t, 'student: homework');
  get('/api/fees/my', t, 'student: fees');
  get('/api/chat/unread-count', t, 'student: unread chat'); think();
  const hwId = ((data || []).find((d) => d && d.school === acc.code) || {}).id;
  const mine = (bodyOf(hw).data) || [];
  if (hwId && Array.isArray(mine) && mine.some((h) => h && String(h._id) === String(hwId)) && Math.random() < 0.2) {
    send('POST', `/api/homework/${hwId}/done`, {}, t, 'student: mark homework done'); writes.add(1);
  }
  // Tenant probe: another school's student record must never answer 200 to this student.
  if (Math.random() < PROBE) {
    const other = pick(schools.filter((s) => s.code !== acc.code));
    if (other) { const r = get(`/api/students/${pick(other.students).id}/history`, t, 'tenant probe (student)', [200, 401, 403, 404]); if (carriesData(r)) leak(r); }
  }
}

function parentJourney(acc) {
  const t = state.token;
  if (!state.child) {
    const r = get('/api/parents/my-child', t, 'parent: children');
    const kids = ((bodyOf(r).data) || {}).children || [];
    state.child = (kids[0] || {})._id || '';
    think();
  }
  const q = state.child ? `?studentId=${state.child}` : '';
  get(`/api/attendance/student/${state.child}/summary`, t, 'parent: attendance'); think();
  get(`/api/fees/my${q}`, t, 'parent: fees');
  get('/api/notifications/my', t, 'parent: notifications');
  get('/api/announcements/my', t, 'parent: notices'); think();
  get(`/api/homework/child${q}`, t, 'parent: homework');
  get('/api/events', t, 'parent: events');
  get('/api/chat/unread-count', t, 'parent: unread chat');
  get('/api/chat/inbox', t, 'parent: chat inbox'); think();
  if (Math.random() < 0.15) { // message the class teacher, then read the conversation
    const tr = get('/api/chat/parent-teachers', t, 'parent: chat teachers');
    const teacher = (((bodyOf(tr).data) || {}).teachers || [])[0];
    if (teacher) {
      send('POST', '/api/chat/messages', { receiverId: teacher.userId, text: `LOADTEST ${RUN} hello ${__VU}` }, t, 'parent: send message'); writes.add(1);
      get(`/api/chat/messages/${teacher.roomId}`, t, 'parent: read messages');
    }
  }
  if (Math.random() < PROBE) {
    const other = pick(schools.filter((s) => s.code !== acc.code));
    if (other) { const r = get(`/api/attendance/student/${pick(other.students).id}/summary`, t, 'tenant probe (parent)', [200, 401, 403, 404]); if (carriesData(r)) leak(r); }
  }
}

function teacherJourney(acc) {
  const t = state.token;
  const me = get('/api/teachers/me', t, 'teacher: profile'); think();
  const tid = ((bodyOf(me).data) || {})._id;
  if (tid) get(`/api/timetable/teacher/${tid}`, t, 'teacher: timetable');
  const sec = pick(acc.teacher.sections);
  get(`/api/attendance/class/${encodeURIComponent(sec.class)}?date=${today()}&section=${encodeURIComponent(sec.section)}`, t, 'teacher: class attendance'); think();
  get('/api/leaves/pending', t, 'teacher: pending leaves');
  get('/api/chat/unread-count', t, 'teacher: unread chat');
  get('/api/chat/inbox', t, 'teacher: chat inbox');
  get('/api/chat/teacher-contacts', t, 'teacher: chat contacts');
  get('/api/notifications/my', t, 'teacher: notifications'); think();
  if (Math.random() < 0.2) { // saving attendance for one of their own (test) classes
    const ids = acc.school.sectionStudents.find((x) => x.class === sec.class && x.section === sec.section).ids;
    send('POST', '/api/attendance/bulk', { date: today(), class: sec.class, section: sec.section, records: ids.map((studentId, i) => ({ studentId, status: i % 9 === 0 ? 'Absent' : 'Present' })) }, t, 'teacher: save attendance'); writes.add(1);
  }
}

function adminJourney(acc) {
  const t = state.token;
  get('/api/schools/me/dashboard', t, 'office: dashboard'); think();
  get('/api/students?limit=25', t, 'office: students'); think();
  get('/api/fees', t, 'office: fees');
  get('/api/fees/pending/all', t, 'office: pending fees'); think();
  get('/api/announcements', t, 'office: notices');
  get('/api/academic/setup-status', t, 'office: setup status'); think();
  if (Math.random() < 0.1) { // the office records a small payment on one of a few fees, so several payments land on the same fee at once
    const feeId = pick(acc.school.feeIds.slice(0, 3));
    send('PATCH', `/api/fees/${feeId}/pay`, { amount: 1, mode: 'Cash' }, t, 'office: record fee payment'); writes.add(1);
  }
  if (Math.random() < PROBE) { // another school's records must not answer, even to an office user
    const other = pick(schools.filter((s) => s.code !== acc.code));
    if (other) {
      const id = pick(other.students).id;
      for (const path of [`/api/students/${id}/history`, `/api/fees/${id}`]) { const r = get(path, t, 'tenant probe (office)', [200, 401, 403, 404]); if (carriesData(r)) leak(r); }
    }
  }
  if (Math.random() < 0.05) { // a test-only notice, clearly labelled
    const r = send('POST', '/api/announcements', { title: `LOADTEST ${RUN} notice`, message: 'Created by the load test. Safe to delete.', targetRole: 'all' }, t, 'office: post notice'); writes.add(1);
    const id = ((bodyOf(r).data) || {})._id; if (id) console.log(`CREATED ${JSON.stringify({ collection: 'announcements', id })}`);
  }
}

export default function (data) {
  const { role, seq } = roleOf(__VU);
  const list = accounts[role];
  const acc = list[seq % list.length];
  if (!state.token) { state.token = signIn(acc); if (!state.token) { sleep(5); return; } think(); }
  ({ student: studentJourney, parent: parentJourney, teacher: teacherJourney, admin: adminJourney })[role](acc, data);
  think();
}

export function handleSummary(data) {
  const out = __ENV.SUMMARY_FILE;
  return out ? { [out]: JSON.stringify(data) } : {};
}
