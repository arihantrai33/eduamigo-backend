// The request side of the mixed-activity test (loadtests/mixed-check.js starts it): thousands of people doing different things at once.
// Instead of one k6 virtual user per person (about 3.4 MB each, too much for one laptop), every kind of activity is a stream of
// requests arriving at the rate that many real people would produce, using sign-ins done beforehand. The request mix and rate are what
// the server sees; the people who hold a live bus map open and the drivers' phones are run by mixed-check.js itself.
//
// Settings (environment): BASE_URL, TOKENS_FILE, RATE_SCALE (1 = 3,000 people), RAMP, HOLD, SUMMARY_FILE
import http from 'k6/http';
import { check } from 'k6';
import { Rate, Counter, Trend } from 'k6/metrics';
import exec from 'k6/execution';

const BASE = __ENV.BASE_URL || 'http://127.0.0.1:8113';
const T = JSON.parse(open(__ENV.TOKENS_FILE));
const SCALE = Number(__ENV.RATE_SCALE || 1);
const RAMP = __ENV.RAMP || '2m'; const HOLD = __ENV.HOLD || '8m';
const JSON_H = { 'Content-Type': 'application/json' };
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const day = () => new Date().toLocaleDateString('en-US', { weekday: 'long' });
const today = () => new Date().toISOString().slice(0, 10);

const serverError = new Rate('server_error');
const aiOk = new Rate('ai_answer_ok');
const aiBusy = new Counter('ai_refused');
const aiTime = new Trend('ai_answer_ms', true);
const writes = new Counter('writes_done');

const arrival = (rate, exec, vus = 60, max = 400) => ({
  executor: 'ramping-arrival-rate', startRate: 0, timeUnit: '1s', preAllocatedVUs: vus, maxVUs: max, exec,
  stages: [{ target: Math.max(1, Math.round(rate * SCALE)), duration: RAMP }, { target: Math.max(1, Math.round(rate * SCALE)), duration: HOLD }, { target: 0, duration: '20s' }],
});

export const options = {
  scenarios: {
    browse: arrival(300, 'browse', 80, 500),         // 1,200 people on dashboards, fees, homework, attendance: a request about every 4 s each
    chat_unread: arrival(50, 'chatUnread'),          // 750 people with chat open: the unread badge and inbox about every 15 s
    chat_send: arrival(25, 'chatSend'),              // ... a message about every 30 s
    chat_read: arrival(25, 'chatRead'),              // ... opening a conversation about every 30 s
    chat_reply: arrival(5, 'chatReply', 10, 60),     // teachers answering
    ai: arrival(3.75, 'ai', 60, 400),                // 450 learners asking the AI tutor about every 2 minutes each
  },
  thresholds: {
    'http_req_duration{kind:read}': ['p(95)<500', 'p(99)<1000'],
    'http_req_duration{kind:write}': ['p(95)<800', 'p(99)<1500'],
    'http_req_duration{kind:ai}': ['p(95)<20000'],
    http_req_failed: ['rate<0.01'],
    checks: ['rate>0.99'],
    ai_answer_ok: ['rate>0.98'],
    server_error: [{ threshold: 'rate<0.05', abortOnFail: true, delayAbortEval: '30s' }],
  },
  summaryTrendStats: ['count', 'avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

const auth = (t, name, kind) => ({ headers: { ...JSON_H, Authorization: `Bearer ${t}` }, tags: { name, kind } });
function read(path, token, name) {
  const r = http.get(`${BASE}${path}`, auth(token, name, 'read'));
  serverError.add(r.status === 0 || r.status >= 500);
  check(r, { [`${name} 200`]: (x) => x.status === 200 });
  return r;
}
function write(method, path, body, token, name) {
  const r = http.request(method, `${BASE}${path}`, JSON.stringify(body), auth(token, name, 'write'));
  serverError.add(r.status === 0 || r.status >= 500);
  check(r, { [`${name} ok`]: (x) => x.status === 200 || x.status === 201 });
  writes.add(1);
  return r;
}

// ---- ordinary screens (the same endpoints the website calls)
const READS = {
  student: ['/api/students/my-profile', '/api/attendance/my-summary', `/api/timetable/my?day=${day()}`, '/api/exams/my-results', '/api/notifications/my', '/api/announcements/my', '/api/homework/my', '/api/fees/my', '/api/events'],
  parent: ['/api/parents/my-child', '/api/fees/my', '/api/notifications/my', '/api/announcements/my', '/api/homework/child', '/api/events'],
  teacher: ['/api/teachers/me', '/api/leaves/pending', '/api/chat/unread-count', '/api/notifications/my', '/api/events'],
  admin: ['/api/schools/me/dashboard', '/api/students?limit=25', '/api/fees', '/api/fees/pending/all', '/api/announcements', '/api/academic/setup-status'],
};
// One always-passing threshold per endpoint makes k6 keep separate latency figures for it.
const NAMES = ['teacher: save attendance', 'office: record fee payment', 'chat: unread', 'chat: inbox', 'chat: send message', 'chat: read conversation', 'chat: teacher reply', 'ai: ask the tutor'];
for (const [role, list] of Object.entries(READS)) for (const path of list) NAMES.push(`${role}: ${path.split('?')[0].replace('/api/', '')}`);
for (const n of NAMES) options.thresholds[`http_req_duration{name:${n}}`] = ['max>=0'];

export function browse() {
  const x = Math.random(); const role = x < 0.42 ? 'student' : x < 0.67 ? 'parent' : x < 0.87 ? 'teacher' : 'admin';
  const who = pick(T.browse[role]);
  if (Math.random() < 0.01) { // a few saves among the reading
    if (role === 'teacher' && who.sections) { const s = pick(who.sections); write('POST', '/api/attendance/bulk', { date: today(), class: s.class, section: s.section, records: s.ids.map((studentId, i) => ({ studentId, status: i % 9 === 0 ? 'Absent' : 'Present' })) }, who.token, 'teacher: save attendance'); return; }
    if (role === 'admin' && who.feeIds) { write('PATCH', `/api/fees/${pick(who.feeIds)}/pay`, { amount: 1, mode: 'Cash' }, who.token, 'office: record fee payment'); return; }
  }
  const path = pick(READS[role]);
  read(path, who.token, `${role}: ${path.split('?')[0].replace('/api/', '')}`);
}

// ---- chat
export function chatUnread() {
  const p = pick(T.chat.parents);
  read('/api/chat/unread-count', p.token, 'chat: unread');
  if (Math.random() < 0.2) read('/api/chat/inbox', p.token, 'chat: inbox');
}
export function chatSend() {
  const p = pick(T.chat.parents);
  write('POST', '/api/chat/messages', { receiverId: p.teacherUserId, text: `LOADTEST hello ${__VU}-${__ITER}` }, p.token, 'chat: send message');
}
export function chatRead() {
  const p = pick(T.chat.parents);
  read(`/api/chat/messages/${p.roomId}`, p.token, 'chat: read conversation');
}
export function chatReply() {
  const p = pick(T.chat.parents);
  write('POST', '/api/chat/messages', { receiverId: p.parentUserId, text: `LOADTEST reply ${__VU}-${__ITER}` }, p.teacherToken, 'chat: teacher reply');
}

// ---- Learning AI: ask, read the whole streamed answer
// A different question every time: the tutor caches identical generic questions (that is a feature, but real students do not all ask the same one).
const STEMS = ['Explain Newton second law with an example', 'How do I solve this equation', 'What is photosynthesis? Explain simply', 'Give me a short note on the water cycle', 'What is the difference between speed and velocity', 'Why do we have seasons', 'Explain fractions with a story', 'How does a magnet work'];
export function ai() {
  // Learners take turns (each asks again only after about N / rate seconds), as a real learner cannot ask while the last answer is still being written.
  const s = T.ai[exec.scenario.iterationInTest % T.ai.length];
  const r = http.post(`${BASE}/api/learning/chat`, JSON.stringify({ message: `${pick(STEMS)} (question ${Math.floor(Math.random() * 1e9)})` }), { headers: { ...JSON_H, Authorization: `Bearer ${s.token}` }, tags: { name: 'ai: ask the tutor', kind: 'ai' }, timeout: '90s' });
  serverError.add(r.status === 0 || r.status >= 500);
  const body = r.status === 200 ? String(r.body) : '';
  const ok = r.status === 200 && body.includes('"type":"final"') && !body.includes('"type":"error"');
  aiOk.add(ok);
  if (ok) aiTime.add(r.timings.duration); else if (r.status === 429 || r.status === 503 || body.includes('"type":"error"')) aiBusy.add(1);
  if (!ok && Math.random() < 0.5) console.log(`AIFAIL ${r.status} ${body.slice(-220).replace(/\n/g, ' ') || String(r.body).slice(0, 200)}`);
  check(r, { 'ai answered': () => ok });
}

export function handleSummary(data) {
  return __ENV.SUMMARY_FILE ? { [__ENV.SUMMARY_FILE]: JSON.stringify(data) } : {};
}
