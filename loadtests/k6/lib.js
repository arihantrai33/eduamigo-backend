import http from 'k6/http';
import { check } from 'k6';
import { SharedArray } from 'k6/data';

export const BASE = __ENV.BASE_URL || 'http://localhost:8100';
export const seed = JSON.parse(open('../data/seed.json'));
export const PASSWORD = seed.password;
export const today = () => new Date().toISOString().slice(0, 10);
export const pick = (list) => list[Math.floor(Math.random() * list.length)];

// Each script signs in its own slice of the accounts (SESSION_OFFSET moves it), so scripts run one after another do not use up
// the per-account login limit of 10 attempts per 15 minutes on the same parents.
export const slice = (students, count, defaultOffset) => {
  const offset = Number(__ENV.SESSION_OFFSET || defaultOffset);
  return students.slice(offset, offset + count);
};

export function login(schoolCode, identifier, password = PASSWORD) {
  const res = http.post(`${BASE}/api/users/login`, JSON.stringify({ schoolCode, identifier, password }), { headers: { 'Content-Type': 'application/json' }, tags: { name: 'login' } });
  const ok = check(res, { 'login 200': (r) => r.status === 200, 'login has token': (r) => !!(r.json() || {}).token });
  return ok ? res.json().token : null;
}

export const auth = (token, name) => ({ headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, tags: name ? { name } : undefined });

// Shared acceptance limits (see loadtests/README.md). Every script passes these or adds its own.
export const baseThresholds = {
  http_req_failed: ['rate<0.01'],
  checks: ['rate>0.99'],
};

export { SharedArray };
