// Fee day: the office records payments while parents look at their fees.
// Acceptance: p95 < 1.5 s, 0 server errors, no duplicate receipt numbers and totals that add up (run loadtests/verify.js).
import http from 'k6/http';
import { check } from 'k6';
import { BASE, seed, login, auth, pick, slice, baseThresholds } from './lib.js';

const PAYMENTS_PER_HOUR = Number(__ENV.PAYMENTS_PER_HOUR || 300);
const VIEWS_PER_HOUR = Number(__ENV.VIEWS_PER_HOUR || 600);
const DURATION = __ENV.DURATION || '10m';
const PARENTS_PER_SCHOOL = Number(__ENV.PARENT_SESSIONS || 40);

export const options = {
  scenarios: {
    payments: { executor: 'constant-arrival-rate', exec: 'pay', rate: PAYMENTS_PER_HOUR, timeUnit: '1h', duration: DURATION, preAllocatedVUs: 20, maxVUs: 100 },
    views: { executor: 'constant-arrival-rate', exec: 'view', rate: VIEWS_PER_HOUR, timeUnit: '1h', duration: DURATION, preAllocatedVUs: 20, maxVUs: 100 },
  },
  thresholds: { ...baseThresholds, 'http_req_duration{name:pay}': ['p(95)<1500'], 'http_req_duration{name:myfees}': ['p(95)<1500'] },
};

export function setup() {
  return {
    admins: seed.schools.map((s) => ({ school: s.code, token: login(s.code, s.admin.identifier) })),
    parents: seed.schools.flatMap((s) => slice(s.students, PARENTS_PER_SCHOOL, 0).map((st) => login(s.code, st.parentMobile))).filter(Boolean),
  };
}

export function pay(data) {
  const i = Math.floor(Math.random() * seed.schools.length);
  const fee = pick(seed.schools[i].feeIds);
  // A fee may already be fully paid by an earlier call: that is a correct 409, not a failure.
  const res = http.patch(`${BASE}/api/fees/${fee}/pay`, JSON.stringify({ amount: 500, mode: 'Cash' }), { ...auth(data.admins[i].token, 'pay'), responseCallback: http.expectedStatuses(200, 409) });
  check(res, { 'payment handled': (r) => r.status === 200 || r.status === 409 });
}

export function view(data) {
  const res = http.get(`${BASE}/api/fees/my`, auth(pick(data.parents), 'myfees'));
  check(res, { 'fees shown': (r) => r.status === 200 });
}
