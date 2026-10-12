// EduAmigo Ask under load. Needs an AI provider configured on the server. Acceptance: p95 < 6 s, error rate < 1 %,
// and a sensible answer even when the model is slow (the assistant falls back to the school's records).
import http from 'k6/http';
import { check, sleep } from 'k6';
import { BASE, seed, login, auth, pick, slice, baseThresholds } from './lib.js';

const QUESTIONS = [
  'What is my child\'s attendance this month?', 'Is any fee pending for my child?', 'When is the next exam?',
  'Is there a holiday this week?', 'What is the bus route?', 'What homework is due?', 'Who is the class teacher?',
];
const USERS = Number(__ENV.USERS || 100);

export const options = {
  scenarios: { ask: { executor: 'constant-vus', vus: USERS, duration: __ENV.DURATION || '5m' } },
  thresholds: { ...baseThresholds, 'http_req_duration{name:ask}': ['p(95)<6000'] },
};

export function setup() {
  const all = seed.schools.flatMap((s) => slice(s.students, Math.ceil(USERS / seed.schools.length), 100).map((st) => ({ code: s.code, mobile: st.parentMobile })));
  return all.slice(0, USERS).map((p) => login(p.code, p.mobile)).filter(Boolean);
}

export default function (tokens) {
  const token = tokens[(__VU - 1) % tokens.length];
  const res = http.post(`${BASE}/api/assistant/ask`, JSON.stringify({ message: pick(QUESTIONS) }), { ...auth(token, 'ask'), timeout: '30s' });
  check(res, { 'answered': (r) => r.status === 200 });
  sleep(5 + Math.random() * 10);
}
