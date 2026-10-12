// Soak: steady mixed traffic for a long time (default 30 min; use DURATION=24h for the real run). Watch memory, error logs and
// database connections on the server while it runs. Acceptance: p95 < 1.5 s throughout, error rate < 1 %, no growth in memory.
import http from 'k6/http';
import { check } from 'k6';
import { BASE, seed, login, auth, pick, slice, baseThresholds } from './lib.js';

const RATE = Number(__ENV.REQUESTS_PER_SECOND || 5);
const SESSIONS = Number(__ENV.SESSIONS_PER_SCHOOL || 30);

export const options = {
  scenarios: { soak: { executor: 'constant-arrival-rate', rate: RATE, timeUnit: '1s', duration: __ENV.DURATION || '30m', preAllocatedVUs: 20, maxVUs: 200 } },
  thresholds: { ...baseThresholds, http_req_duration: ['p(95)<1500'] },
};

export function setup() {
  return seed.schools.flatMap((s) => slice(s.students, SESSIONS, 200).map((st) => login(s.code, st.parentMobile))).filter(Boolean);
}

const PAGES = ['/api/users/profile', '/api/fees/my', '/api/notifications/my', '/api/announcements/my', '/api/events', '/api/students/my-child'];

export default function (tokens) {
  const res = http.get(`${BASE}${pick(PAGES)}`, auth(pick(tokens), 'soak'));
  check(res, { 'ok': (r) => r.status === 200 });
}
