// End-to-end resolution is measured on outcomes (a grounded answer nobody had to repeat, a ticket staff resolved),
// not on the topic being found. Controlled log rows, so every number can be checked by hand.
const { connect, disconnect, clear, seedSchool } = require('./helpers');
const AssistantQuery = require('../src/models/AssistantQuery');
const AssistantTicket = require('../src/models/AssistantTicket');
const { schoolMetrics } = require('../src/assistant/metrics');

let A;
beforeAll(connect);
afterAll(disconnect);
beforeEach(async () => { await clear(); A = await seedSchool('Alpha School'); });

const NOW = new Date('2026-10-05T12:00:00Z');
const at = (min) => new Date(NOW.getTime() - min * 60000);
async function log(user, minutesAgo, part, extra = {}) {
  return AssistantQuery.create({
    school: A.school._id, user: user._id, role: user.role, text: 'q', action: part.action, parts: [{ confidence: 1, method: 'model', ...part }],
    createdAt: at(minutesAgo), ...extra,
  });
}
const ticket = (status, resolvedMinutesAfter = null) => AssistantTicket.create({
  school: A.school._id, number: `T-${Math.floor(Math.random() * 9000) + 1000}`, raisedBy: A.parentUser._id, raisedRole: 'parent', question: 'q', reason: 'requested',
  team: 'office', status, createdAt: at(300), resolvedAt: resolvedMinutesAfter === null ? null : new Date(at(300).getTime() + resolvedMinutesAfter * 60000),
});

test('only outcomes that settled the person\'s need count as resolved', async () => {
  // 1. grounded answer, never repeated: resolved by the assistant
  await log(A.parentUser, 200, { action: 'answer', domain: 'fees', sources: 2 });
  // 2. answer that cited nothing: not resolved
  await log(A.studentUser, 190, { action: 'answer', domain: 'fees', sources: 0, grounded: false });
  // 3. answer marked unhelpful: not resolved
  await log(A.teacherUser, 180, { action: 'answer', domain: 'attendance', sources: 1 }, { feedback: { helpful: false, at: at(179) } });
  // 4. answer followed by the same question again within 10 minutes: not resolved
  await log(A.admin, 170, { action: 'answer', domain: 'fees', sources: 1, text: 'pending fees of class 9-A' });
  await log(A.admin, 166, { action: 'answer', domain: 'fees', sources: 1, text: 'pending fees of class 9-A please' });
  // 4b. a different question on the same topic is not a repeat: it settles
  await log(A.otherStudentUser, 60, { action: 'answer', domain: 'fees', sources: 1, text: 'fees of Kabir' });
  await log(A.otherStudentUser, 58, { action: 'answer', domain: 'fees', sources: 1, text: 'bus fee of Riya' });
  // 5. hand-off whose ticket staff resolved after 3 hours: resolved by staff; an open one is pending
  const done = await ticket('resolved', 180);
  const open = await ticket('open');
  await log(A.parentUser, 150, { action: 'handoff', domain: 'exams', method: 'rule', ticket: done._id });
  await log(A.studentUser, 140, { action: 'handoff', domain: 'exams', method: 'rule', ticket: open._id });
  // 6. a clarifying question that was never answered: unresolved; one that got an answer: not counted twice
  await log(A.otherStudentUser, 130, { action: 'clarify', domain: 'fees' });
  // 7. a refusal because access is not allowed: correct behaviour, left out
  await log(A.studentUser, 100, { action: 'blocked', domain: 'hr' });

  const m = await schoolMetrics(A.school._id, { now: NOW });
  expect(m.resolution).toMatchObject({ resolvedByAssistant: 4, resolvedByStaff: 1, pending: 1 });
  // 4 settled by the assistant (1, the second of 4, and both of 4b), 1 by staff; unresolved: 2, 3, the first of 4 (repeated), the clarify
  expect(m.resolution.unresolved).toBe(4);
  expect(m.rates.resolution).toBe(Math.round((5 / 9) * 1000) / 10);
  expect(m.resolution.avgTicketHours).toBe(3);
});

test('grounding: model-written answers that were thrown away by the number and name check are counted', async () => {
  await log(A.parentUser, 60, { action: 'answer', domain: 'fees', sources: 1, composition: 'composed' });
  await log(A.studentUser, 50, { action: 'answer', domain: 'fees', sources: 1, composition: 'composed' });
  await log(A.teacherUser, 40, { action: 'answer', domain: 'fees', sources: 1, composition: 'kept_original' });
  const m = await schoolMetrics(A.school._id, { now: NOW });
  expect(m.grounding).toEqual({ composed: 2, keptStandard: 1, rejectedPct: 33.3 });
  expect(m.rates.sourceCitation).toBe(100);
});
