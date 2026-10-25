/* eslint-disable no-console */
// Read-only check of a running EduAmigo API, for right after a deploy (staging or production). It creates and changes nothing.
//   BASE_URL=https://your-api.example  node loadtests/smoke.js
//   BASE_URL=... SMOKE_SCHOOL=ABC SMOKE_ID=admin@school.in SMOKE_PASSWORD=...  node loadtests/smoke.js      (also signs in and reads a few things)
// Passwords and tokens are read from the environment and never printed. Exit code 1 if any check fails.
const BASE = (process.env.BASE_URL || '').replace(/\/+$/, '');
if (!/^https?:\/\//.test(BASE)) { console.error('Set BASE_URL, for example BASE_URL=https://eduamigo-staging.onrender.com'); process.exit(2); }
const secure = BASE.startsWith('https://');
const results = [];

async function call(path, { method = 'GET', token, body, headers = {}, timeout = 25000 } = {}) {
  const started = Date.now();
  const res = await fetch(`${BASE}${path}`, {
    method, signal: AbortSignal.timeout(timeout),
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined, redirect: 'manual',
  });
  let json = null; try { json = await res.json(); } catch (e) { /* not JSON */ }
  return { status: res.status, headers: res.headers, json, ms: Date.now() - started };
}
async function check(name, fn) {
  let ok = false; let why = '';
  try { const r = await fn(); ok = r === true || (r && r.ok === true); why = (r && r.why) || ''; } catch (e) { why = String(e.message).slice(0, 140); }
  results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !why ? '' : `  (${why})`}`);
}

(async () => {
  console.log(`Smoke check of ${BASE}\n`);
  await check('the API answers /api/health and the database is up', async () => { const r = await call('/api/health'); return { ok: r.status === 200 && r.json && r.json.db === 'up', why: `status ${r.status}, ${r.ms} ms${r.ms > 8000 ? ' (a free instance may have been asleep)' : ''}` }; });
  await check('security headers are present (nosniff, framing, referrer policy)', async () => {
    const h = (await call('/api/health')).headers;
    const missing = ['x-content-type-options', 'x-frame-options', 'referrer-policy'].filter((k) => !h.get(k));
    if (secure && !h.get('strict-transport-security')) missing.push('strict-transport-security');
    return { ok: !missing.length, why: `missing ${missing.join(', ')}` };
  });
  await check('an error does not leak internals (unknown route gives a plain JSON 404)', async () => { const r = await call('/api/does-not-exist'); return { ok: r.status === 404 && r.json && r.json.success === false && !/at .*\.js|node_modules/.test(JSON.stringify(r.json)), why: `status ${r.status}` }; });
  await check('school data is refused without signing in (students, fees, profile)', async () => {
    const bad = []; for (const p of ['/api/students', '/api/fees', '/api/users/profile']) { const r = await call(p); if (r.status !== 401) bad.push(`${p} -> ${r.status}`); }
    return { ok: !bad.length, why: bad.join('; ') };
  });
  await check('an altered sign-in token is refused', async () => (await call('/api/students', { token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjEifQ.AAAA' })).status === 401);
  if (secure) {
    await check('a website that is not allowed cannot call the API from a browser (CORS)', async () => {
      const r = await call('/api/users/login', { method: 'OPTIONS', headers: { Origin: 'https://not-allowed.example', 'Access-Control-Request-Method': 'POST' } });
      return { ok: !r.headers.get('access-control-allow-origin'), why: `allowed origin: ${r.headers.get('access-control-allow-origin')}` };
    });
  }
  if (process.env.SMOKE_SCHOOL) {
    await check(`the school ${process.env.SMOKE_SCHOOL} can be found (public lookup)`, async () => { const r = await call(`/api/public/schools/${encodeURIComponent(process.env.SMOKE_SCHOOL)}`); return { ok: r.status === 200, why: `status ${r.status}` }; });
  }
  if (process.env.SMOKE_SCHOOL && process.env.SMOKE_ID && process.env.SMOKE_PASSWORD) {
    let token; let role;
    await check('signing in works and a wrong password is refused', async () => {
      const wrong = await call('/api/users/login', { method: 'POST', body: { schoolCode: process.env.SMOKE_SCHOOL, identifier: process.env.SMOKE_ID, password: `${process.env.SMOKE_PASSWORD}-wrong` } });
      const right = await call('/api/users/login', { method: 'POST', body: { schoolCode: process.env.SMOKE_SCHOOL, identifier: process.env.SMOKE_ID, password: process.env.SMOKE_PASSWORD } });
      token = right.json && right.json.token; role = right.json && right.json.user && right.json.user.role;
      return { ok: wrong.status === 401 && right.status === 200 && !!token, why: `wrong ${wrong.status}, right ${right.status}, ${right.ms} ms` };
    });
    if (token) {
      await check('the signed-in profile, notifications and dashboard data load', async () => {
        const reads = ['/api/users/profile', '/api/notifications/my']; if (['admin', 'accountant', 'staff', 'superadmin'].includes(role)) reads.push('/api/schools/me/dashboard');
        const bad = []; for (const p of reads) { const r = await call(p, { token }); if (r.status !== 200) bad.push(`${p} -> ${r.status}`); }
        return { ok: !bad.length, why: bad.join('; ') };
      });
      await check('the session can be used more than once (token stays valid)', async () => (await call('/api/users/profile', { token })).status === 200);
    }
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} of ${results.length} checks passed${failed.length ? `, ${failed.length} FAILED` : ''}.`);
  process.exit(failed.length ? 1 : 0);
})();
