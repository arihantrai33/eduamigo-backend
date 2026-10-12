// Cross-school check over HTTP, for a real (staging) server seeded by loadtests/seed.js. Read-only: it only reads.
//   BASE_URL=https://staging.example node loadtests/isolation-check.js
// Each school's admin asks for the other schools' students, fees and users by id, and for the usual lists. Nothing that belongs to another
// school may appear. Exit code 1 if anything does.
const fs = require('fs');
const path = require('path');

const BASE = (process.env.BASE_URL || 'http://localhost:8100').replace(/\/+$/, '');
const seed = JSON.parse(fs.readFileSync(path.join(__dirname, 'data/seed.json'), 'utf8'));
const hex24 = /[a-f0-9]{24}/g;

async function call(method, url, token) {
  const res = await fetch(`${BASE}${url}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
  return { status: res.status, text: await res.text() };
}

async function main() {
  const tokens = {};
  for (const s of seed.schools) {
    const res = await fetch(`${BASE}/api/users/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ schoolCode: s.code, identifier: s.admin.identifier, password: seed.password }) });
    if (!res.ok) throw new Error(`Cannot sign in to ${s.code}: ${res.status}`);
    tokens[s.code] = (await res.json()).token;
  }
  const idsOf = (s) => new Set([s.id, ...s.students.map((x) => x.id), ...s.feeIds]);
  let calls = 0;
  const problems = [];
  for (const me of seed.schools) {
    const others = seed.schools.filter((s) => s.code !== me.code);
    const foreign = new Set(others.flatMap((s) => [...idsOf(s)]));
    const lists = ['/api/students', '/api/fees', '/api/fees/all', '/api/teachers', '/api/parents', '/api/attendance/dashboard', '/api/notifications', '/api/announcements', '/api/users'];
    const targets = [...lists];
    for (const o of others) {
      for (const st of o.students.slice(0, 5)) targets.push(`/api/students/${st.id}`, `/api/fees/${st.id}`, `/api/attendance/student/${st.id}`, `/api/report-cards/student/${st.id}`);
      for (const f of o.feeIds.slice(0, 5)) targets.push(`/api/fees/${f}/receipts/RCPT-0`);
    }
    for (const url of targets) {
      const { status, text } = await call('GET', url, tokens[me.code]);
      calls += 1;
      const supplied = new Set(url.match(hex24) || []);
      const leaked = [...new Set(text.match(hex24) || [])].filter((id) => foreign.has(id) && !supplied.has(id));
      if (leaked.length) problems.push(`${me.code} GET ${url}: ${leaked.length} foreign id(s)`);
      if (status >= 500) problems.push(`${me.code} GET ${url}: server error ${status}`);
      if (/^\/api\/(students|fees|attendance|report-cards)\/[a-f0-9]{24}/.test(url) && url.match(hex24).some((id) => foreign.has(id)) && status === 200 && /"data":\s*(\{|\[[^\]])/.test(text) && !/"data":\s*\[\s*\]/.test(text)) {
        problems.push(`${me.code} GET ${url}: returned data for another school's id`);
      }
    }
  }
  console.log(`${calls} calls across ${seed.schools.length} schools`);
  if (problems.length) { console.log(problems.join('\n')); console.log(`\n${problems.length} problem(s)`); process.exit(1); }
  console.log('No cross-school data seen');
}

main().catch((err) => { console.error(err.message); process.exit(1); });
