/* eslint-disable no-console */
// Answer-quality check for EduAmigo Ask, run against a running demo (npm run demo, default school GVPS).
//
//   npm run demo                       (terminal 1; add PORT=8300 to use another port)
//   npm run assistant:answers          (terminal 2; BASE=http://localhost:8300 to match; add -- --save to keep the result for the dashboard)
//
// Each case in src/assistant/eval/answers.json asks one question as one person (parent, student, teacher, admin) and checks
// the reply: the action (answer / hand-off / no data), the facts it must contain, the facts it must not contain (another
// child's data), and for hand-offs the person the ticket was sent to. The routing evaluation (assistant:eval) measures
// whether the right topic was found; this one measures whether the person got the right answer.
const { cases, conversations = [] } = require('../assistant/eval/answers.json');

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
  const only = process.argv.slice(2).find((a) => !a.startsWith('--'));
  // --batch=final runs only the questions written after all fixes (never tuned on).
  const batch = (process.argv.find((a) => a.startsWith('--batch=')) || '').slice(8) || null;
  const byConv = [];
  let pass = 0; let total = 0; let freshPass = 0; let freshTotal = 0; const failed = [];
  for (const [i, c] of cases.entries()) {
    if (only && !c.q.toLowerCase().includes(only.toLowerCase())) continue;
    if (batch && c.batch !== batch) continue;
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
  // Conversations: several turns in one chat (follow-ups, topic switches, a clarifying question answered by the next turn).
  for (const conv of conversations) {
    if (batch) continue;
    if (only && !conv.name.toLowerCase().includes(only.toLowerCase())) continue;
    total += 1;
    let conversationId = null;
    const problems = [];
    const shownTurns = [];
    for (const [t, turn] of conv.turns.entries()) {
      const res = await post('/assistant/ask', { message: turn.q, ...(conversationId ? { conversationId } : {}) }, tokens[conv.who]);
      conversationId = res.data?.conversationId || conversationId;
      const replies = res.data?.replies || [];
      const text = replies.map((r) => r.text).join('\n');
      shownTurns.push(`${turn.q} -> ${text.replace(/\n/g, ' | ').slice(0, 160)}`);
      if (!replies.length) problems.push(`turn ${t + 1}: no reply`);
      if (turn.action && !replies.some((r) => turn.action.split('|').includes(r.action))) problems.push(`turn ${t + 1}: action ${replies.map((r) => r.action).join('+')} instead of ${turn.action}`);
      for (const p of turn.all || []) if (!matches(text, p)) problems.push(`turn ${t + 1}: missing /${p}/`);
      for (const p of turn.none || []) if (matches(text, p)) problems.push(`turn ${t + 1}: must not contain /${p}/`);
      for (const o of turn.options || []) if (!replies.some((r) => (r.options || []).some((x) => matches(x.label, o)))) problems.push(`turn ${t + 1}: no option /${o}/`);
    }
    if (!problems.length) pass += 1; else failed.push({ n: `conversation ${conv.name}`, c: { q: conv.name, who: conv.who }, text: shownTurns.join('\n'), problems });
    byConv.push({ name: conv.name, ok: !problems.length });
    console.log(`${problems.length ? 'FAIL' : 'ok  '} conversation [${conv.who}] ${conv.name} (${conv.turns.length} turns)`);
    if (problems.length || process.env.VERBOSE) shownTurns.forEach((x) => console.log(`      ${x}`));
    for (const p of problems) console.log(`      - ${p}`);
  }

  // --save keeps the result for the admin dashboard (the numbers shown there come from this file, never typed in).
  if (process.argv.includes('--save') && !only) {
    const file = require('path').join(__dirname, '../assistant/eval/last-answers-report.json');
    const byRole = {};
    for (const c of cases) byRole[c.who] = byRole[c.who] || { questions: 0, correct: 0 };
    cases.forEach((c, i) => { byRole[c.who].questions += 1; if (!failed.some((f) => f.n === i + 1)) byRole[c.who].correct += 1; });
    if (byConv.length) byRole['multi-turn chats'] = { questions: byConv.length, correct: byConv.filter((x) => x.ok).length };
    require('fs').writeFileSync(file, JSON.stringify({
      savedAt: new Date().toISOString(), questions: total, correct: pass, accuracy: Math.round((pass / Math.max(1, total)) * 1000) / 10,
      fresh: { questions: freshTotal, correct: freshPass }, byRole,
      conversations: { questions: byConv.length, correct: byConv.filter((x) => x.ok).length },
      failures: failed.map((f) => ({ q: f.c.q, who: f.c.who, reply: f.text.slice(0, 300), problems: f.problems })),
    }, null, 2));
    console.log(`Saved ${file}`);
  }
  if (freshTotal) console.log(`${freshPass}/${freshTotal} on fresh questions written after the fixes (${Math.round((freshPass / freshTotal) * 1000) / 10}%)`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e.message); process.exit(2); });
