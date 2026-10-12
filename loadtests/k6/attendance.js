// Morning rush: every teacher of every school saves their classes' attendance within a short window; each class is saved twice
// (the second save changes a few statuses) to exercise the update path.
// Acceptance: p95 < 1.5 s, 0 server errors, one attendance row per student afterwards (run loadtests/verify.js).
import http from 'k6/http';
import { check, sleep } from 'k6';
import { BASE, seed, login, auth, today, baseThresholds } from './lib.js';

const teachers = seed.schools.flatMap((s) => s.teachers.map((t) => ({ code: s.code, ...t, sectionStudents: s.sectionStudents })));
const WINDOW = Number(__ENV.WINDOW_SECONDS || 600);

export const options = {
  scenarios: { rush: { executor: 'per-vu-iterations', vus: teachers.length, iterations: 1, maxDuration: `${WINDOW + 300}s` } },
  thresholds: { ...baseThresholds, 'http_req_duration{name:attendance}': ['p(95)<1500'] },
};

export function setup() {
  return teachers.map((t) => login(t.code, t.identifier));
}

export default function (tokens) {
  const me = teachers[__VU - 1];
  const token = tokens[__VU - 1];
  sleep(Math.random() * WINDOW); // teachers do not all press save together
  for (const sec of me.sections) {
    const ids = me.sectionStudents.find((x) => x.class === sec.class && x.section === sec.section).ids;
    for (const round of [0, 1]) {
      const records = ids.map((studentId, i) => ({ studentId, status: (i + round) % 9 === 0 ? 'Absent' : 'Present' }));
      const res = http.post(`${BASE}/api/attendance/bulk`, JSON.stringify({ date: today(), class: sec.class, section: sec.section, records }), auth(token, 'attendance'));
      check(res, { 'attendance saved': (r) => r.status === 200 });
      sleep(2);
    }
  }
}
