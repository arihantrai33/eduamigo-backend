// School documents as an answer source: splitting, admin-only management, tenant isolation, role audience,
// retrieval with real citations, and "not written down" when the school has no answer.
process.env.ASSISTANT_AI = 'off';

const { api, connect, disconnect, clear, auth, seedSchool } = require('./helpers');
const SchoolDocument = require('../src/models/SchoolDocument');
const AssistantTicket = require('../src/models/AssistantTicket');
const { splitSections, search } = require('../src/services/knowledge');

let A; let B;
beforeAll(connect);
afterAll(disconnect);
beforeEach(async () => { await clear(); A = await seedSchool('Alpha School'); B = await seedSchool('Beta School'); });

const HANDBOOK = `SCHOOL TIMINGS
Classes run from 8:00 AM to 2:30 PM, Monday to Saturday. The gate opens at 7:30 AM.

UNIFORM
Boys wear a blue shirt and grey trousers. Girls wear a blue shirt and a grey skirt. Black shoes are compulsory.

Fee refund policy:
Fees paid are refundable within 15 days of admission only. Transport fees are not refundable.`;

const add = (user, body) => api().post('/api/assistant/knowledge').set(auth(user)).send(body);
const ask = (user, message) => api().post('/api/assistant/ask').set(auth(user)).send({ message });

describe('splitting a document', () => {
  test('headings start sections, numbering is dropped, and short text stays whole', () => {
    const s = splitSections(HANDBOOK);
    expect(s.map((x) => x.heading)).toEqual(['SCHOOL TIMINGS', 'UNIFORM', 'Fee refund policy']);
    expect(s[0].text).toContain('8:00 AM to 2:30 PM');
    expect(splitSections('1. Leave\nApply two days before.').map((x) => x.heading)).toEqual(['Leave']);
  });
});

describe('retrieval picks the right section', () => {
  const FEES = `FEE PAYMENT
Tuition is paid in two terms. Fees can be paid online or at the counter. Late fee applies after the due date.

LATE FEE
A late fee of Rs 50 per week is charged after the due date. Pay the fee on time to avoid the late fee.

REFUNDS
Admission fees are not refundable. Tuition is refundable only if the student leaves within 15 days.`;

  test('the document title does not outweigh the section that really answers; "refundable" meets "refund"', async () => {
    await add(A.admin, { title: 'Fee payment and refund policy', text: FEES });
    const hit = await search({ school: A.school._id, role: 'parent', queries: ['what is the fee refund policy'] });
    expect(hit[0].heading).toBe('REFUNDS');
    const late = await search({ school: A.school._id, role: 'parent', queries: ['how much is the late fee'] });
    expect(late[0].heading).toBe('LATE FEE');
  });

  test('"time" finds a section about "timings", and a stray word like "start" does not outrank it', async () => {
    await add(A.admin, { title: 'Parent handbook', text: `SCHOOL TIMINGS
Classes run from 8:00 AM to 2:30 PM, Monday to Saturday. The gate opens at 7:30 AM.

REFUNDS
Tuition is refundable only if the student leaves within 15 days of the start of the term.` });
    const hit = await search({ school: A.school._id, role: 'parent', queries: ['what time does school start in the morning'], expand: ['school start time morning opening hours schedule'] });
    expect(hit[0].heading).toBe('SCHOOL TIMINGS');
  });
});

describe('managing documents', () => {
  test('only admins manage them, and each school only ever touches its own', async () => {
    expect((await add(A.parentUser, { title: 'Handbook', text: HANDBOOK })).status).toBe(403);
    expect((await add(A.teacherUser, { title: 'Handbook', text: HANDBOOK })).status).toBe(403);
    const made = await add(A.admin, { title: 'Parent handbook', category: 'handbook', text: HANDBOOK });
    expect(made.status).toBe(201);
    expect(made.body.data).toMatchObject({ title: 'Parent handbook', sections: 3, version: 1, sourceType: 'text' });

    const id = made.body.data.id;
    const theirs = await api().get('/api/assistant/knowledge').set(auth(B.admin));
    expect(theirs.body.data).toEqual([]);
    expect((await api().patch(`/api/assistant/knowledge/${id}`).set(auth(B.admin)).send({ isActive: false })).status).toBe(404);
    expect((await api().delete(`/api/assistant/knowledge/${id}`).set(auth(B.admin))).status).toBe(404);

    const edited = await api().patch(`/api/assistant/knowledge/${id}`).set(auth(A.admin)).send({ text: 'UNIFORM\nWhite shirt only.' });
    expect(edited.body.data).toMatchObject({ version: 2, sections: 1 });
    expect((await api().delete(`/api/assistant/knowledge/${id}`).set(auth(A.admin))).status).toBe(200);
    expect(await SchoolDocument.countDocuments({})).toBe(0);
  });

  test('a document needs a title and readable text', async () => {
    expect((await add(A.admin, { title: '', text: HANDBOOK })).status).toBe(400);
    expect((await add(A.admin, { title: 'Empty', text: '   ' })).status).toBe(400);
    expect((await add(A.admin, { title: 'Bad', category: 'secret', text: HANDBOOK })).status).toBe(400);
  });
});

describe('answering from documents', () => {
  beforeEach(async () => { await add(A.admin, { title: 'Parent handbook', category: 'handbook', text: HANDBOOK }); });

  test('a parent gets the written answer with the document, section and date as the source', async () => {
    const res = await ask(A.parentUser, 'school uniform kya hai');
    const r = res.body.data.replies[0];
    expect(r).toMatchObject({ domain: 'policies', action: 'answer' });
    expect(r.text).toContain('blue shirt');
    expect(r.sources[0]).toMatchObject({ type: 'document', label: 'Parent handbook · UNIFORM' });
    expect(r.sources[0].evidence).toContain('Black shoes are compulsory');
    expect(r.sources[0].at).toBeTruthy();
  });

  test('a question about a refund policy is a question, not an urgent complaint', async () => {
    const res = await ask(A.parentUser, 'what is the fee refund policy');
    expect(res.body.data.replies[0]).toMatchObject({ domain: 'policies', action: 'answer' });
    expect(res.body.data.replies[0].text).toContain('15 days');
    expect(await AssistantTicket.countDocuments({})).toBe(0);
  });

  test('when the school has not written it down, the person is told so and offered the office, not a guess', async () => {
    const res = await ask(A.parentUser, 'school ki uniform policy me tie ki zarurat hai kya library membership');
    const r = res.body.data.replies[0];
    expect(['no_data', 'answer']).toContain(r.action);
    const none = await ask(A.studentUser, 'what is the policy on mobile phones in school');
    expect(none.body.data.replies[0]).toMatchObject({ action: 'no_data' });
    expect(none.body.data.replies[0].options[0]).toMatchObject({ type: 'handoff' });
    expect(await AssistantTicket.countDocuments({})).toBe(0);
  });

  test('a document for teachers is never used to answer a parent, and another school\'s documents are never used', async () => {
    await add(A.admin, { title: 'Staff code of conduct', audience: ['teacher'], text: 'DRESS CODE\nTeachers wear formal clothes and carry the ID card every day.' });
    expect((await ask(A.teacherUser, 'what is the dress code')).body.data.replies[0].sources[0].label).toContain('Staff code of conduct');
    const parent = await ask(A.parentUser, 'what is the dress code');
    expect(parent.body.data.replies.map((r) => r.text).join(' ')).not.toContain('ID card');
    const other = await ask(B.parentUser, 'school uniform kya hai');
    expect(other.body.data.replies[0].action).not.toBe('answer');
  });

  test('synonyms from the model help a section match but do not make a one-word question harder', async () => {
    const hit = await search({ school: A.school._id, role: 'parent', queries: ['school ka uniform batao'], expand: ['dress', 'attire', 'clothing', 'wear'] });
    expect(hit[0].heading).toBe('UNIFORM');
    const hours = await search({ school: A.school._id, role: 'parent', queries: ['school kitne baje khulta hai', 'What time does the school open?'], expand: ['timing', 'timings', 'hours', 'opens', 'schedule'] });
    expect(hours[0].heading).toBe('SCHOOL TIMINGS');
  });

  test('a restatement that adds a general word ("rules") does not hide the one rare word that matters ("uniform")', async () => {
    const hit = await search({ school: A.school._id, role: 'parent', queries: ['school ka uniform batao', 'What are the school uniform rules? school ka uniform batao'], expand: ['dress', 'code', 'clothing'] });
    expect(hit[0].heading).toBe('UNIFORM');
  });

  test('retrieval needs real overlap: unrelated words find nothing', async () => {
    expect(await search({ school: A.school._id, role: 'parent', queries: ['rocket launch schedule'] })).toEqual([]);
    const hit = await search({ school: A.school._id, role: 'parent', queries: ['What is the uniform for girls?'] });
    expect(hit[0]).toMatchObject({ heading: 'UNIFORM' });
  });
});
