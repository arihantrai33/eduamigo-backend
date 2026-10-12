// Year-end for one school (about 1,000 students): preview, apply, and apply again (must be safe to repeat).
// Acceptance: finishes without a timeout in under 2 minutes, and the repeat changes nothing.
import http from 'k6/http';
import { check } from 'k6';
import { Trend } from 'k6/metrics';
import { BASE, seed, login, auth } from './lib.js';

const took = new Trend('yearend_apply_ms', true);
export const options = {
  scenarios: { yearend: { executor: 'shared-iterations', vus: 1, iterations: 1, maxDuration: '15m' } },
  thresholds: { yearend_apply_ms: ['max<120000'], checks: ['rate==1'] },
};

export default function () {
  const school = seed.schools[0];
  const token = login(school.code, school.admin.identifier);
  const long = { ...auth(token, 'yearend'), timeout: '600s' };
  const preview = http.get(`${BASE}/api/academic/year-end?toSession=${school.nextSession}`, long);
  check(preview, { 'preview 200': (r) => r.status === 200 });
  const apply = () => http.post(`${BASE}/api/academic/year-end`, JSON.stringify({ toSession: school.nextSession, makeCurrent: false }), long);
  const first = apply();
  took.add(first.timings.duration);
  check(first, { 'apply 200': (r) => r.status === 200 });
  const again = apply();
  check(again, { 'repeat 200': (r) => r.status === 200, 'repeat changes nothing': (r) => { const d = r.json().data || {}; return !d.promote && !d.detain && !d.graduate; } });
}
