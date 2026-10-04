/* eslint-disable no-console */
// Answer-quality check for EduAmigo Ask, run against a running demo (npm run demo, default school GVPS).
//
//   npm run demo                       (terminal 1; add PORT=8300 to use another port)
//   npm run assistant:answers          (terminal 2; BASE=http://localhost:8300 to match)
//
// Each case in src/assistant/eval/answers.json asks one question as one person (parent, student, teacher, admin) and checks
// the reply: the action (answer / hand-off / no data), the facts it must contain, the facts it must not contain (another
// child's data), and for hand-offs the person the ticket was sent to. The routing evaluation (assistant:eval) measures
// whether the right topic was found; this one measures whether the person got the right answer.
const { cases } = require('../assistant/eval/answers.json');

const BASE = (process.env.BASE || 'http://localhost:8000').replace(/\/$/, '');
const SCHOOL = process.env.SCHOOL || 'GVPS';
const PASSWORD = 'Demo@1234';
const PEOPLE = { parent: '9876543210', parent2: '9812345678', student: '1', teacher: 'teacher@gvps.demo', admin: 'admin@gvps.demo' };

async function post(path, body, token) {
  const res = await fetch(`${BASE}/api${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  return res.json();
}

const matches = (text, pattern) => new RegExp(pattern, 'i').test(text);

(async () => {
  const tokens = {};
  for (const [who, id] of Object.entries(PEOPLE)) {
    const r = await post('/users/login', { schoolCode: SCHOOL, identifier: id, password: PASSWORD });
    if (!r.token) throw new Error(`Cannot sign in as ${who} (${id}) at ${BASE}: ${r.message || 'no token'}`);
    tokens[who] = r.token;
  }
  const only = process.argv[2];
  let pass = 0; let total = 0; let freshPass = 0; let freshTotal = 0; const failed = [];
  for (const [i, c] of cases.entries()) {
    if (only && !c.q.toLowerCase().includes(only.toLowerCase())) continue;
    total += 1;
    const started = Date.now();
    const res = await post('/assistant/ask', { message: c.q }, tokens[c.who]);
    const ms = Date.now() - started;
    const replies = res.data?.replies || [];
    const text = replies.map((r) => r.text).join('\n');
    const problems = [];
    if (!replies.length) problems.push(`no reply (${res.message || 'error'})`);
    const actions = replies.map((r) => r.action);
    if (c.action && !actions.some((a) => c.action.split('|').includes(a))) problems.push(`action ${actions.join('+')} instead of ${c.action}`);
    for (const p of c.all || []) if (!matches(text, p)) problems.push(`missing /${p}/`);
    for (const p of c.none || []) if (matches(text, p)) problems.push(`must not contain /${p}/`);
    if (c.ticketTo) {
      const to = replies.flatMap((r) => (r.ticket?.sentTo || []).map((s) => `${s.name} ${s.title}`)).join(' ');
      if (!matches(to, c.ticketTo)) problems.push(`ticket went to "${to || 'nobody'}" instead of ${c.ticketTo}`);
    }
    if (c.fresh) { freshTotal += 1; if (!problems.length) freshPass += 1; }
    if (!problems.length) pass += 1; else failed.push({ n: i + 1, c, text, problems });
    console.log(`${problems.length ? 'FAIL' : 'ok  '} ${String(i + 1).padStart(2)} [${c.who}] ${c.q}  (${ms} ms)`);
    if (problems.length || process.env.VERBOSE) console.log(`      ${text.replace(/\n/g, ' | ').slice(0, 300)}`);
    for (const p of problems) console.log(`      - ${p}`);
  }
  console.log(`\n${pass}/${total} answers correct (${Math.round((pass / Math.max(1, total)) * 1000) / 10}%)`);
  if (freshTotal) console.log(`${freshPass}/${freshTotal} on fresh questions written after the fixes (${Math.round((freshPass / freshTotal) * 1000) / 10}%)`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e.message); process.exit(2); });
