// EduAmigo Learning AI and the study-help route in Ask. Every model call is mocked (no provider is contacted):
// global.fetch answers Azure OpenAI requests from queues, streamed (SSE) or JSON.

const { api, connect, disconnect, clear, auth, seedSchool, scheduleExam } = require('./helpers');
const School = require('../src/models/School');
const Note = require('../src/models/Note');
const NoteEmbedding = require('../src/models/NoteEmbedding');
const AssistantTicket = require('../src/models/AssistantTicket');
const LearningConversation = require('../src/models/LearningConversation');
const PracticeSession = require('../src/models/PracticeSession');
const llm = require('../src/assistant/llm');
const skills = require('../src/assistant/skills');
const { teach, systemPrompt } = require('../src/learning/tutor');
const { findMaterials } = require('../src/learning/materials');
const { formatDay, toDayKey } = require('../src/utils/dates');

let A;
let B;
let calls;
let streams;
let jsons;
const ENV = { ...process.env };
const enc = new TextEncoder();

const sse = (pieces) => ({
  ok: true,
  body: (async function* body() {
    for (const p of pieces) yield enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`);
    yield enc.encode('data: [DONE]\n\n');
  }()),
});
const jsonReply = (content) => ({ ok: true, json: async () => ({ choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }) });

beforeAll(connect);
afterAll(async () => { process.env = ENV; await disconnect(); });
beforeEach(async () => {
  await clear();
  A = await seedSchool('Alpha School');
  B = await seedSchool('Beta School');
  process.env = { ...ENV, ASSISTANT_AI: 'on', ASSISTANT_PROVIDERS: 'azure', AZURE_OPENAI_ENDPOINT: 'https://example.openai.azure.com', AZURE_OPENAI_API_KEY: 'k', AZURE_OPENAI_DEPLOYMENT: 'gpt-test', GEMINI_API_KEY: '', LEARNING_VECTOR_SEARCH: 'off' };
  llm.resetForTests();
  calls = []; streams = []; jsons = [];
  global.fetch = jest.fn(async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push(body);
    if (body.stream) return sse(streams.length ? streams.shift() : ['(no answer queued)']);
    return jsonReply(jsons.length ? jsons.shift() : { questions: [] });
  });
});

// Teacher-uploaded material: 10-A and whole class 10 notes in school A, decoys elsewhere.
async function seedNotes() {
  const note = async (school, title, cls, section, subject, text, type = 'Notes') => {
    const n = await Note.create({ school, title, subject, class: cls, section, type, processing: { status: 'ready' } });
    await NoteEmbedding.create({ noteId: n._id, school, class: cls, section, subject, chunkText: text, chunkIndex: 0, embedding: [0.1] });
    return n;
  };
  const photo = await note(A.school._id, 'Chapter 6: Photosynthesis', '10', 'A', 'Science',
    'Photosynthesis is the process by which green plants make glucose from carbon dioxide and water using sunlight. Chlorophyll absorbs the light. Oxygen is released.');
  await note(A.school._id, 'Fractions worksheet', '10', '', 'Mathematics', 'Adding fractions: make the denominators equal, then add the numerators. 3/4 + 1/8 = 6/8 + 1/8 = 7/8.', 'Assignment');
  await note(A.school._id, 'Photosynthesis for section B', '10', 'B', 'Science', 'Photosynthesis section B special notes about chlorophyll and sunlight and glucose.');
  await note(A.school._id, 'Class 9 photosynthesis', '9', '', 'Science', 'Photosynthesis class nine notes about chlorophyll glucose sunlight.');
  await note(B.school._id, 'Other school photosynthesis', '10', 'A', 'Science', 'Photosynthesis in Beta school with chlorophyll glucose sunlight.');
  return { photo };
}

const ndjson = (res) => String(res.text || '').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const chat = (user, body) => api().post('/api/learning/chat').set(auth(user)).send(body).buffer(true).parse((res, cb) => { let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => cb(null, t)); });
const events = async (user, body) => { const res = await chat(user, body); return { res, ev: JSON.parse(`[${String(res.body).trim().split('\n').filter(Boolean).join(',')}]`) }; };

describe('Ask: study help is answered, never turned into a ticket', () => {
  const ask = (user, message) => api().post('/api/assistant/ask').set(auth(user)).send({ message });
  const understood = (parts, language = 'hinglish') => ({ language, questions: parts.map((p) => ({ confidence: 0.9, alternative: null, safety: 'none', about: 'self', english: p.text, ...p })) });

  test('a lesson doubt the model labels "forward" is answered by the tutor, with no ticket', async () => {
    await seedNotes();
    jsons.push(understood([{ text: 'photosynthesis samajh nahi aa raha', topic: 'learning', kind: 'forward', subject: 'Science', brief: { title: 'Doubt', summary: 'x', request: 'y' } }]));
    streams.push(['Photosynthesis matlab plants sunlight se khana banate hain [S1]. ', 'Chlorophyll light absorb karta hai.']);
    const res = await ask(A.studentUser, 'photosynthesis samajh nahi aa raha');
    expect(res.status).toBe(200);
    const r = res.body.data.replies[0];
    expect(r).toMatchObject({ domain: 'learning', action: 'answer' });
    expect(r.text).toContain('[S1]');
    expect(r.sources[0].label).toContain('Chapter 6: Photosynthesis');
    expect(r.link.path).toMatch(/^\/student\/learn\?q=/);
    expect(await AssistantTicket.countDocuments({})).toBe(0);
  });

  test('a study request the model files under another topic as "forward" is still answered (server decides)', async () => {
    jsons.push(understood([{ text: 'chapter 3 explain karo', topic: 'notes', kind: 'forward' }]));
    streams.push(['Chapter 3 ka summary: ...']);
    const res = await ask(A.studentUser, 'chapter 3 explain karo');
    expect(res.body.data.replies[0].domain).toBe('learning');
    expect(await AssistantTicket.countDocuments({})).toBe(0);
  });

  test('an explicit request to pass a doubt to the teacher still creates a ticket', async () => {
    jsons.push(understood([{ text: 'maths teacher ko bolo ki mera doubt clear kare', topic: 'learning', kind: 'forward', subject: 'Mathematics', brief: { title: 'Doubt for Maths teacher', summary: 'Student wants a doubt cleared.', request: 'Clear the doubt.' } }]));
    const res = await ask(A.studentUser, 'maths teacher ko bolo ki mera doubt clear kare');
    expect(res.body.data.replies[0].action).toBe('handoff');
    expect(await AssistantTicket.countDocuments({})).toBe(1);
  });

  test('without a model, study questions in English, Hinglish and Hindi go to learning help and never to a ticket', async () => {
    process.env.ASSISTANT_AI = 'off';
    for (const q of ['explain photosynthesis', 'fractions samjhao please', 'mujhe yeh sawal solve karna hai 2x+3=11', 'प्रकाश संश्लेषण समझाओ', 'samajh nahi aaya']) {
      for (let i = 0; i < 3; i += 1) {
        const res = await ask(A.studentUser, q);
        const r = res.body.data.replies[0];
        expect({ q, domain: r.domain, action: r.action }).toEqual({ q, domain: 'learning', action: 'answer' });
        expect(r.text).toMatch(/not available|not been sent/);
      }
    }
    expect(await AssistantTicket.countDocuments({})).toBe(0);
  });

  test('a records question is still a records question (fees), and a parent gets a general explanation without class notes', async () => {
    process.env.ASSISTANT_AI = 'off';
    const fees = await ask(A.parentUser, 'fees kitni baki hai');
    expect(fees.body.data.replies[0].domain).toBe('fees');
    process.env.ASSISTANT_AI = 'on';
    jsons.push(understood([{ text: 'explain fractions', topic: 'learning', kind: 'learn' }], 'en'));
    streams.push(['A fraction is a part of a whole.']);
    const res = await ask(A.parentUser, 'explain fractions');
    const r = res.body.data.replies[0];
    expect(r.domain).toBe('learning');
    expect(r.link).toBeNull(); // the AI Tutor screen is for students
    expect(r.reliability.reason).toMatch(/only searched for students/);
  });

  test('a failure reading records is reported as a failure for that part only, never as "nothing found"', async () => {
    process.env.ASSISTANT_AI = 'off';
    const spy = jest.spyOn(skills.fees, 'run').mockRejectedValueOnce(new Error('database timeout'));
    const res = await ask(A.parentUser, 'fees kitni baki hai');
    spy.mockRestore();
    expect(res.status).toBe(200);
    const r = res.body.data.replies[0];
    expect(r.action).toBe('error');
    expect(r.text).toMatch(/could not check the fees records just now/);
    expect(r.text).toMatch(/not a "no records" answer/);
    expect(r.text).not.toMatch(/no .*pending|nothing (is )?due/i);
  });
});

describe('school material for the tutor', () => {
  test('only the student\'s own school, class and section (plus whole-class material) is searched', async () => {
    await seedNotes();
    const m = await findMaterials({ schoolId: A.school._id, cls: '10', section: 'A', query: 'what is photosynthesis chlorophyll' });
    expect(m.checked).toBe(true);
    expect(m.method).toBe('lexical');
    expect(m.passages.map((p) => p.title)).toEqual(['Chapter 6: Photosynthesis']);
    expect(m.passages[0]).toMatchObject({ ref: 'S1', type: 'Notes', subject: 'Science', part: 1 });
    const none = await findMaterials({ schoolId: A.school._id, cls: '10', section: 'A', query: 'french revolution causes' });
    expect(none).toMatchObject({ passages: [], checked: true });
  });
});

describe('AI Tutor chat', () => {
  test('streams an answer grounded in the school notes, with sources, a reliability note and saved history', async () => {
    await seedNotes();
    streams.push(['Photosynthesis is how plants make food [S1].', ' Chlorophyll absorbs light.']);
    const { res, ev } = await events(A.studentUser, { message: 'What is photosynthesis?' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/ndjson/);
    const meta = ev.find((e) => e.type === 'meta');
    expect(meta.sources.map((s) => s.title)).toEqual(['Chapter 6: Photosynthesis']);
    expect(ev.filter((e) => e.type === 'delta').map((e) => e.text).join('')).toContain('[S1]');
    const final = ev.find((e) => e.type === 'final');
    expect(final.used.map((u) => u.title)).toEqual(['Chapter 6: Photosynthesis']);
    expect(final.confidence).toMatchObject({ level: 'high' });
    expect(final.timings).toEqual(expect.objectContaining({ retrievalMs: expect.any(Number), firstTokenMs: expect.any(Number), totalMs: expect.any(Number) }));
    // The notes reached the model only as quoted data in the user message, never in the system prompt.
    const sent = calls[0].messages;
    expect(sent[0].role).toBe('system');
    expect(sent[0].content).not.toContain('green plants make glucose');
    expect(sent[sent.length - 1].content).toMatch(/SCHOOL MATERIAL[\s\S]*<<<[\s\S]*green plants make glucose[\s\S]*>>>/);
    const conv = await LearningConversation.findOne({ school: A.school._id, user: A.studentUser._id });
    expect(conv.turns.map((t) => t.role)).toEqual(['user', 'assistant']);
    expect(final.conversationId).toBe(String(conv._id));
  });

  test('a general explanation (notes do not cover it) is labelled as such: moderate, not school-backed', async () => {
    await seedNotes();
    streams.push(['The French Revolution began in 1789. This is a general explanation, not from your school notes.']);
    const { ev } = await events(A.studentUser, { message: 'Why did the French Revolution happen?' });
    const final = ev.find((e) => e.type === 'final');
    expect(final.used).toEqual([]);
    expect(final.confidence).toMatchObject({ level: 'moderate', reason: expect.stringMatching(/school notes do not cover/) });
  });

  test('a passage that was found but not cited is not claimed as a source', async () => {
    await seedNotes();
    streams.push(['Plants make food using light.']);
    const { ev } = await events(A.studentUser, { message: 'photosynthesis chlorophyll' });
    const final = ev.find((e) => e.type === 'final');
    expect(ev.find((e) => e.type === 'meta').sources.length).toBe(1);
    expect(final.used).toEqual([]);
    expect(final.confidence.level).toBe('moderate');
  });

  test('maths: the hidden check block is re-computed; a right answer is "checked", a wrong one "needs verification"', async () => {
    streams.push(['2x + 3 = 11\n2x = 8\nx = 4\n\n```check\n{"type":"equation","equation":"2x + 3 = 11","variable":"x","answer":"4"}\n```']);
    let { ev } = await events(A.studentUser, { message: 'solve 2x + 3 = 11' });
    let final = ev.find((e) => e.type === 'final');
    expect(final.text).not.toContain('```check');
    expect(final.checks).toEqual([expect.objectContaining({ status: 'passed', kind: 'equation' })]);
    expect(final.confidence).toMatchObject({ level: 'high', reason: expect.stringMatching(/checked by substitution.*not every statement/) });

    streams.push(['3/4 + 1/8 = 4/12\n```check\n{"type":"value","expr":"3/4 + 1/8","answer":"4/12"}\n```']);
    ({ ev } = await events(A.studentUser, { message: 'add 3/4 and 1/8' }));
    final = ev.find((e) => e.type === 'final');
    expect(final.checks[0]).toMatchObject({ status: 'failed' });
    expect(final.confidence.level).toBe('needs_verification');
  });

  test('a valid diagram is passed on as data; an invalid one is dropped and the text stands', async () => {
    streams.push(['Here is the graph.\n```diagram\n{"type":"graph","expr":"x^2 - 1","xMin":-3,"xMax":3}\n```\nAnd a broken one:\n```diagram\n{"type":"svg","svg":"<script>alert(1)</script>"}\n```']);
    const { ev } = await events(A.studentUser, { message: 'show the graph of x squared minus 1' });
    const final = ev.find((e) => e.type === 'final');
    expect(final.diagrams).toHaveLength(1);
    expect(final.diagrams[0]).toMatchObject({ type: 'graph', title: 'y = x^2 - 1', alt: expect.stringContaining('Graph of') });
    expect(final.diagrams[0].points.length).toBeGreaterThan(50);
    expect(final.text).toContain('[[diagram:0]]');
    expect(final.text).not.toMatch(/script|svg/);
  });

  test('follow-ups keep the conversation: the earlier turns are sent with the new question', async () => {
    streams.push(['A fraction is part of a whole.']);
    const first = await events(A.studentUser, { message: 'what is a fraction' });
    const conversationId = first.ev.find((e) => e.type === 'final').conversationId;
    streams.push(['Think of a pizza cut into 8 slices...']);
    await events(A.studentUser, { message: 'aur simple samjhao', conversationId });
    const sent = calls[calls.length - 1].messages;
    expect(sent.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(sent[1].content).toBe('what is a fraction');
    expect(sent[2].content).toBe('A fraction is part of a whole.');
    // The system prompt asks for a different approach when the student did not understand.
    expect(sent[0].content).toMatch(/do NOT repeat yourself/);
    expect(sent[0].content).toMatch(/Hinglish/);
  });

  test('the reply language follows the student: Hindi in, Hindi asked for', () => {
    expect(systemPrompt({ role: 'student', cls: '7', mode: 'tutor', language: 'hi' })).toMatch(/Reply in Hindi in Devanagari/);
    expect(systemPrompt({ role: 'student', cls: '7', mode: 'guided', language: 'en' })).toMatch(/GUIDED LEARNING mode/);
  });

  test('no model configured: an honest "unavailable" error, no invented answer; the question is kept', async () => {
    process.env.ASSISTANT_AI = 'off';
    const { ev } = await events(A.studentUser, { message: 'what is gravity' });
    expect(ev.map((e) => e.type)).toEqual(['meta', 'error']);
    expect(ev[1]).toMatchObject({ code: 'AI_UNAVAILABLE' });
    expect(calls).toHaveLength(0);
    const conv = await LearningConversation.findOne({ school: A.school._id, user: A.studentUser._id });
    expect(conv.turns.map((t) => t.role)).toEqual(['user']);
  });

  test('provider failure before any text: an honest error; a cancelled request stops without an error', async () => {
    global.fetch = jest.fn(async () => ({ ok: false, status: 500, text: async () => 'down', headers: { get: () => null } }));
    const { ev } = await events(A.studentUser, { message: 'what is gravity' });
    expect(ev.find((e) => e.type === 'error')).toMatchObject({ code: 'AI_FAILED' });

    const controller = new AbortController();
    controller.abort();
    global.fetch = jest.fn(async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); });
    const out = await teach({ role: 'student', student: null, schoolId: A.school._id, message: 'x', signal: controller.signal });
    expect(out.type).toBe('cancelled');
  });

  test('history: list, open, delete one, clear all; another student cannot open it', async () => {
    streams.push(['One.']);
    const { ev } = await events(A.studentUser, { message: 'first question' });
    const id = ev.find((e) => e.type === 'final').conversationId;
    const list = await api().get('/api/learning/conversations').set(auth(A.studentUser));
    expect(list.body.data).toEqual([expect.objectContaining({ _id: id, title: 'first question', turns: 2 })]);
    expect((await api().get(`/api/learning/conversations/${id}`).set(auth(A.otherStudentUser))).status).toBe(404);
    expect((await api().get(`/api/learning/conversations/${id}`).set(auth(B.studentUser))).status).toBe(404);
    expect((await chat(A.otherStudentUser, { message: 'hi', conversationId: id })).status).toBe(404);
    expect((await api().delete(`/api/learning/conversations/${id}`).set(auth(A.studentUser))).status).toBe(200);
    streams.push(['Two.']);
    await events(A.studentUser, { message: 'second' });
    const cleared = await api().delete('/api/learning/conversations').set(auth(A.studentUser));
    expect(cleared.body.data.deleted).toBe(1);
  });

  test('students only; the school must have the AI revision feature', async () => {
    for (const u of [A.parentUser, A.teacherUser, A.admin]) expect((await chat(u, { message: 'x' })).status).toBe(403);
    await School.updateOne({ _id: A.school._id }, { $set: { 'subscription.disabledFeatures': ['ai_revision'] } });
    expect((await chat(A.studentUser, { message: 'x' })).status).toBe(403);
  });
});

describe('Practice & Assessment', () => {
  const Q = {
    mcq: { format: 'mcq', difficulty: 'easy', topic: 'Fractions', prompt: 'What is 3/4 + 1/8?', options: ['7/8', '4/12', '1/2', '5/8'], answer: '7/8', hint: 'Make the denominators equal.', solution: '6/8 + 1/8 = 7/8', check: { type: 'value', expr: '3/4 + 1/8', answer: '7/8' } },
    mcqBadKey: { format: 'mcq', prompt: 'Which is largest of these?', options: ['1', '2', '3', '4'], answer: '5', hint: 'h', solution: 's' },
    mcqWrongCheck: { format: 'mcq', prompt: 'What is 2 + 2 here?', options: ['3', '4', '5', '6'], answer: '5', hint: 'h', solution: 's', check: { type: 'value', expr: '2+2', answer: '5' } },
    numeric: { format: 'numeric', topic: 'Fractions', prompt: 'Write 3/4 as a decimal.', answer: '0.75', hint: 'Divide 3 by 4.', solution: '3 ÷ 4 = 0.75', check: { type: 'value', expr: '3/4', answer: '0.75' } },
    numericUnchecked: { format: 'numeric', prompt: 'A train travels 120 km in 2 hours. Speed in km/h?', answer: '60', hint: 'h', solution: 's' },
    short: { format: 'short', topic: 'Fractions', prompt: 'What does the denominator of a fraction tell you?', answer: 'How many equal parts the whole is divided into.', points: ['equal parts', 'the whole'], accept: ['the number of parts in the whole'], hint: 'Look at the bottom number.', solution: 'The denominator is the number of equal parts.' },
  };
  const create = (body = {}) => api().post('/api/learning/practice').set(auth(A.studentUser)).send({ subject: 'Mathematics', topic: 'Fractions', count: 5, ...body });

  test('only questions whose answer keys check out are shown, and the keys stay on the server', async () => {
    jsons.push({ questions: [Q.mcq, Q.mcqBadKey, Q.mcqWrongCheck, Q.numeric, Q.numericUnchecked, Q.short] });
    jsons.push({ answers: [{ n: 1, option: '7/8' }] }); // independent answer to the surviving mcq
    const res = await create();
    expect(res.status).toBe(201);
    const s = res.body.data;
    expect(s.questions.map((q) => q.format)).toEqual(['mcq', 'numeric', 'short']);
    expect(s.dropped).toBe(3);
    const text = JSON.stringify(s);
    for (const secret of ['0.75', 'equal parts', '6/8 + 1/8']) expect(text).not.toContain(secret);
    expect(s.questions[0].options).toEqual(['7/8', '4/12', '1/2', '5/8']);
    // The verification call saw the questions without their keys.
    const verify = calls[1].messages[1].content;
    expect(verify).toContain('What is 3/4 + 1/8?');
    expect(verify).not.toMatch(/answer|7\/8"?\s*$/i);
  });

  test('a multiple-choice key that the independent answer disagrees with is dropped', async () => {
    jsons.push({ questions: [Q.mcq, Q.numeric] });
    jsons.push({ answers: [{ n: 1, option: '5/8' }] });
    const res = await create();
    expect(res.body.data.questions.map((q) => q.format)).toEqual(['numeric']);
    expect(res.body.data.dropped).toBe(1);
  });

  test('marking: equivalent numbers and units are accepted, a wrong try gets a hint, the solution comes after; adaptive difficulty', async () => {
    jsons.push({ questions: [Q.mcq, Q.numeric, Q.short] });
    jsons.push({ answers: [{ n: 1, option: '7/8' }] });
    const s = (await create({ difficulty: 'easy' })).body.data;
    const answer = (questionId, a) => api().post(`/api/learning/practice/${s._id}/answer`).set(auth(A.studentUser)).send({ questionId, answer: a });
    const [mcq, num, short] = s.questions;

    let r = await answer(num.id, '0.8');
    expect(r.body.data).toMatchObject({ verdict: 'incorrect', hint: 'Divide 3 by 4.' });
    expect(r.body.data.solution).toBeUndefined();
    r = await answer(num.id, '3/4');
    expect(r.body.data).toMatchObject({ verdict: 'correct', method: 'number', solution: '3 ÷ 4 = 0.75' });

    r = await answer(mcq.id, 'A');
    expect(r.body.data.verdict).toBe('correct');

    jsons.push({ verdict: 'correct', feedback: 'Right: the parts of the whole.' });
    r = await answer(short.id, 'it says into how many same size pieces the whole thing is cut');
    expect(r.body.data).toMatchObject({ verdict: 'correct', method: 'model' });
    const grading = calls[calls.length - 1].messages;
    expect(grading[0].content).toMatch(/Judge the meaning, not the wording/);
    expect(r.body.data.summary).toMatchObject({ answered: 3, total: 3, nextDifficulty: 'medium' });

    // A finished question cannot be re-answered; the set now shows answers and solutions.
    expect((await answer(mcq.id, 'B')).status).toBe(409);
    const view = await api().get(`/api/learning/practice/${s._id}`).set(auth(A.studentUser));
    expect(view.body.data.questions[1]).toMatchObject({ answer: '0.75', solution: '3 ÷ 4 = 0.75' });
  });

  test('numeric answers with units or "x =" are read as numbers', async () => {
    jsons.push({ questions: [{ ...Q.numeric, prompt: 'Perimeter of a square of side 3 cm?', answer: '12', check: { type: 'value', expr: '4*3', answer: '12' } }] });
    const s = (await create({ formats: ['numeric'] })).body.data;
    const r = await api().post(`/api/learning/practice/${s._id}/answer`).set(auth(A.studentUser)).send({ questionId: s.questions[0].id, answer: '12 cm' });
    expect(r.body.data.verdict).toBe('correct');
  });

  test('a question already given recently is not given again', async () => {
    jsons.push({ questions: [Q.numeric] });
    await create({ formats: ['numeric'] });
    jsons.push({ questions: [Q.numeric, { ...Q.numeric, prompt: 'Write 1/4 as a decimal.', answer: '0.25', check: { type: 'value', expr: '1/4', answer: '0.25' } }] });
    const second = (await create({ formats: ['numeric'] })).body.data;
    expect(second.questions.map((q) => q.prompt)).toEqual(['Write 1/4 as a decimal.']);
  });

  test('another student cannot open or answer my set; without a model there is an honest error', async () => {
    jsons.push({ questions: [Q.numeric] });
    const s = (await create({ formats: ['numeric'] })).body.data;
    expect((await api().get(`/api/learning/practice/${s._id}`).set(auth(A.otherStudentUser))).status).toBe(404);
    expect((await api().post(`/api/learning/practice/${s._id}/answer`).set(auth(B.studentUser)).send({ questionId: s.questions[0].id, answer: '1' })).status).toBe(404);
    process.env.ASSISTANT_AI = 'off';
    const res = await create();
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('AI_UNAVAILABLE');
    // A 503 written for the student keeps its words (the error handler hides other 5xx messages).
    expect(res.body.message).toMatch(/Practice questions need the AI/);
    expect(await PracticeSession.countDocuments({ school: A.school._id, user: A.studentUser._id })).toBe(1);
  });
});

describe('Revision Planner and Learning Progress', () => {
  const day = (n) => formatDay(new Date(toDayKey().getTime() + n * 86400000));
  const plan = (user, body) => api().post('/api/learning/plan').set(auth(user)).send(body);

  test('a plan from the student\'s own exam date: study then practice, a review day, nothing invented', async () => {
    const res = await plan(A.studentUser, { examDate: day(10), examName: 'Maths unit test', minutesPerDay: 90, topics: [{ subject: 'Maths', topic: 'Fractions' }, { subject: 'Maths', topic: 'Decimals' }] });
    expect(res.status).toBe(201);
    const p = res.body.data;
    expect(p).toMatchObject({ examDate: day(10), examSource: 'student', title: 'Maths unit test', warnings: [] });
    expect(p.items.filter((i) => i.kind === 'study').map((i) => i.topic)).toEqual(['Fractions', 'Decimals']);
    expect(p.items.filter((i) => i.kind === 'practice')).toHaveLength(2);
    expect(p.items[p.items.length - 1]).toMatchObject({ kind: 'review', date: day(9) });
    for (const i of p.items) expect(i.date < day(10)).toBe(true);
  });

  test('missing or impossible schedules are refused or explained; too little time is named, not hidden', async () => {
    expect((await plan(A.studentUser, { minutesPerDay: 60, topics: [{ subject: 'Maths', topic: 'x' }] })).body.message).toMatch(/Choose an exam/);
    expect((await plan(A.studentUser, { examDate: day(-1), minutesPerDay: 60, topics: [{ subject: 'Maths', topic: 'x' }] })).status).toBe(400);
    expect((await plan(A.studentUser, { examDate: '2026-02-30', minutesPerDay: 60, topics: [{ subject: 'Maths', topic: 'x' }] })).body.message).toMatch(/not a valid date/);
    expect((await plan(A.studentUser, { examDate: day(5), minutesPerDay: 60, topics: [] })).body.message).toMatch(/at least one topic/);
    const many = Array.from({ length: 12 }, (_, i) => ({ subject: 'Science', topic: `Topic ${i + 1}` }));
    const tight = (await plan(A.studentUser, { examDate: day(3), minutesPerDay: 30, topics: many })).body.data;
    expect(tight.warnings.join(' ')).toMatch(/did not fit before the exam/);
    expect(tight.warnings.join(' ')).toMatch(/Topic 12/);
  });

  test('an exam from the school schedule; another class\'s exam is refused; weak practice topics come first', async () => {
    const exam = await scheduleExam(A, { date: toDayKey(day(14)), subject: 'Mathematics', title: 'Half Yearly' });
    const other = await scheduleExam(A, { date: toDayKey(day(14)), class: '9', section: 'A' });
    await PracticeSession.create({ school: A.school._id, user: A.studentUser._id, subject: 'Maths', topic: 'Decimals', questions: [{ id: 'q1', format: 'numeric', prompt: 'p...', answer: '1' }],
      attempts: [{ questionId: 'q1', verdict: 'incorrect' }, { questionId: 'q1', verdict: 'incorrect' }, { questionId: 'q1', verdict: 'correct' }] });
    expect((await plan(A.studentUser, { examId: String(other._id), minutesPerDay: 60, topics: [{ subject: 'Maths', topic: 'x' }] })).status).toBe(404);
    const p = (await plan(A.studentUser, { examId: String(exam._id), minutesPerDay: 120, topics: [{ subject: 'Maths', topic: 'Fractions' }, { subject: 'Maths', topic: 'Decimals' }] })).body.data;
    expect(p).toMatchObject({ examSource: 'school', title: 'Half Yearly (Mathematics)' });
    const studies = p.items.filter((i) => i.kind === 'study');
    expect(studies[0]).toMatchObject({ topic: 'Decimals', reason: 'Weak in practice: 1 of 3 correct' });
    expect(p.items.filter((i) => i.topic === 'Decimals' && i.kind === 'practice')).toHaveLength(2);

    const ctx = await api().get('/api/learning/context').set(auth(A.studentUser));
    expect(ctx.body.data.exams.map((e) => e.title)).toEqual(['Half Yearly']);
    expect(ctx.body.data.capabilities.webResearch).toBe(false);

    const done = await api().patch(`/api/learning/plan/${p._id}/items/${studies[0].id}`).set(auth(A.studentUser)).send({ done: true });
    expect(done.body.data.done).toBe(1);
    expect((await api().patch(`/api/learning/plan/${p._id}/items/${studies[0].id}`).set(auth(A.otherStudentUser)).send({ done: true })).status).toBe(404);

    const progress = (await api().get('/api/learning/progress').set(auth(A.studentUser))).body.data;
    expect(progress.weak).toEqual([expect.objectContaining({ subject: 'Maths', topic: 'Decimals', accuracy: 33 })]);
    expect(progress.plan).toMatchObject({ done: 1 });
  });
});

describe('Practice marking when the AI fails', () => {
  test('a short answer that cannot be marked is not recorded as wrong', async () => {
    jsons.push({ questions: [{ format: 'short', prompt: 'What does the denominator tell you?', answer: 'The number of equal parts.', points: ['equal parts'], hint: 'h', solution: 's' }] });
    const s = (await api().post('/api/learning/practice').set(auth(A.studentUser)).send({ subject: 'Mathematics', formats: ['short'] })).body.data;
    global.fetch = jest.fn(async () => ({ ok: false, status: 500, text: async () => 'down', headers: { get: () => null } }));
    const r = await api().post(`/api/learning/practice/${s._id}/answer`).set(auth(A.studentUser)).send({ questionId: s.questions[0].id, answer: 'parts' });
    expect(r.status).toBe(503);
    expect(r.body.message).toMatch(/could not be marked just now. Nothing was recorded/);
    expect((await PracticeSession.findById(s._id)).attempts).toHaveLength(0);
  });
});

describe('worked answers without a check block', () => {
  test('the calculation behind the final answer is extracted and re-computed by the server', async () => {
    streams.push(['Selling price is 90% of the marked price.\n45 = 0.9 × MP\nMP = 45 ÷ 0.9 = 50\n**Answer:** The marked price was ₹50.']);
    jsons.push({ checks: [{ type: 'value', expr: '45 / 0.9', answer: '50' }] });
    let { ev } = await events(A.studentUser, { message: 'A pen costs ₹45 after a 10% discount. What was the marked price?' });
    let final = ev.find((e) => e.type === 'final');
    expect(final.checks).toEqual([expect.objectContaining({ status: 'passed' })]);
    expect(final.confidence.level).toBe('high');
    expect(final.timings.verifyMs).toEqual(expect.any(Number));
    expect(calls[calls.length - 1].messages[0].content).toMatch(/Never correct the solution; copy its final answer/);

    // A wrong final answer: the extracted expression does not give it, so the answer is flagged.
    streams.push(['MP = 45 ÷ 0.9 = 55\n**Answer:** ₹55.']);
    jsons.push({ checks: [{ type: 'value', expr: '45 / 0.9', answer: '55' }] });
    ({ ev } = await events(A.studentUser, { message: 'A pen costs ₹45 after a 10% discount. Marked price?' }));
    final = ev.find((e) => e.type === 'final');
    expect(final.checks[0]).toMatchObject({ status: 'failed' });
    expect(final.confidence.level).toBe('needs_verification');
  });

  test('no extra call for answers without numbers', async () => {
    streams.push(['Photosynthesis is how plants make food.']);
    await events(A.studentUser, { message: 'what is photosynthesis' });
    expect(calls).toHaveLength(1); // only the streamed answer
  });
});
