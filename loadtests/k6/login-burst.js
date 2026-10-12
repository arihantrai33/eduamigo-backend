// Parents signing in in a burst (start of the school day). Acceptance: p95 < 1 s, error rate < 1 %.
// Accounts are different on every call, so the per-account login limits are not hit. Raise API_ANON_PER_MINUTE on the server first
// (a single load generator looks like one address): see loadtests/README.md.
import http from 'k6/http';
import { check } from 'k6';
import exec from 'k6/execution';
import { BASE, seed, PASSWORD, baseThresholds } from './lib.js';

const parents = seed.schools.flatMap((s) => s.students.map((st) => ({ code: s.code, mobile: st.parentMobile })));
const RATE = Number(__ENV.LOGINS_PER_SECOND || 5);
const DURATION = __ENV.DURATION || '5m';

export const options = {
  scenarios: { burst: { executor: 'constant-arrival-rate', rate: RATE, timeUnit: '1s', duration: DURATION, preAllocatedVUs: 50, maxVUs: 300 } },
  thresholds: { ...baseThresholds, 'http_req_duration{name:login}': ['p(95)<1000'] },
};

export default function () {
  const p = parents[exec.scenario.iterationInTest % parents.length]; // a different account every time, until the list wraps
  const res = http.post(`${BASE}/api/users/login`, JSON.stringify({ schoolCode: p.code, identifier: p.mobile, password: PASSWORD }), { headers: { 'Content-Type': 'application/json' }, tags: { name: 'login' } });
  check(res, { 'signed in': (r) => r.status === 200 && !!r.json().token });
}
