// Usage-based AI cost control and the tutor's context handling. Every provider call is mocked (global.fetch): nothing here is paid for.
// The prices used in the tests are made-up round numbers, only to check the arithmetic; they are not provider prices.

const { api, connect, disconnect, clear, auth, seedSchool } = require('./helpers');
const School = require('../src/models/School');
const Note = require('../src/models/Note');
const NoteEmbedding = require('../src/models/NoteEmbedding');
const AiUsage = require('../src/models/AiUsage');
const AssistantTicket = require('../src/models/AssistantTicket');
const LearningConversation = require('../src/models/LearningConversation');
const llm = require('../src/assistant/llm');
const aiUsage = require('../src/services/aiUsage');
const cache = require('../src/learning/cache');
const { resolveLanguage } = require('../src/learning/tutor');

let A;
let B;
let calls;
let streams;
let jsons;
let streamUsage;
let hold = null;
const ENV = { ...process.env };
const enc = new TextEncoder();

const sse = (pieces, usage) => ({
  ok: true,
  body: (async function* body() {
    for (const p of pieces) {
      if (hold) await hold.promise;
      yield enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`);
    }
    if (usage) yield enc.encode(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: usage.prompt, completion_tokens: usage.completion } })}\n\n`);
    yield enc.encode('data: [DONE]\n\n');
  }()),
});
const jsonReply = (content) => ({ ok: true, json: async () => ({ choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }], usage: { prompt_tokens: 40, completion_tokens: 10 } }) });

beforeAll(connect);
afterAll(async () => { process.env = ENV; await disconnect(); });
beforeEach(async () => {
  await clear();
  A = await seedSchool('Alpha School');
  B = await seedSchool('Beta School');
  process.env = { ...ENV, ASSISTANT_AI: 'on', ASSISTANT_PROVIDERS: 'azure', AZURE_OPENAI_ENDPOINT: 'https://example.openai.azure.com', AZURE_OPENAI_API_KEY: 'k', AZURE_OPENAI_DEPLOYMENT: 'gpt-test', GEMINI_API_KEY: '', LEARNING_VECTOR_SEARCH: 'off' };
  delete process.env.AI_PRICING;
  llm.resetForTests(); cache.clear(); aiUsage.resetForTests();
  calls = []; streams = []; jsons = []; streamUsage = { prompt: 123, completion: 45 }; hold = null;
  global.fetch = jest.fn(async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push(body);
    if (body.stream) return sse(streams.length ? streams.shift() : ['(no answer queued)'], streamUsage);
    return jsonReply(jsons.length ? jsons.shift() : { questions: [] });
  });
});

const PRICES = JSON.stringify({ currency: 'USD', models: { 'azure:gpt-test': { inputPer1M: 1000, outputPer1M: 2000 } } }); // made-up numbers for the arithmetic only
const parse = (res) => JSON.parse(`[${String(res.body).trim().split('\n').filter(Boolean).join(',')}]`);
const chat = (user, body) => api().post('/api/learning/chat').set(auth(user)).send(body).buffer(true).parse((res, cb) => { let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => cb(null, t)); });
const events = async (user, body) => { const res = await chat(user, body); return { res, ev: res.status === 200 ? parse(res) : [] }; };
const finalOf = (ev) => ev.find((e) => e.type === 'final');
const rows = async (extra = {}) => { await aiUsage.flush(); return AiUsage.find({ school: A.school._id, ...extra }).lean(); };
const setLimits = (school, limits) => School.updateOne({ _id: school._id }, { $set: Object.fromEntries(Object.entries(limits).map(([k, v]) => [`subscription.limits.${k}`, v])) });

async function addNote(school, { title = 'Chapter 6: Photosynthesis', cls = '10', section = 'A', subject = 'Science', text = 'Photosynthesis is the process by which green plants make glucose from carbon dioxide and water using sunlight. Chlorophyll absorbs the light.', type = 'Notes' } = {}) {
  const n = await Note.create({ school, title, subject, class: cls, section, type, processing: { status: 'ready' } });
  await NoteEmbedding.create({ noteId: n._id, school, class: cls, section, subject, chunkText: text, chunkIndex: 0, embedding: [0.1] });
  return n;
}

describe('a school that does not use the AI pays for no AI calls', () => {
  test('ordinary ERP browsing, the Learning AI screens and Ask\'s intro make no provider call and write no usage rows', async () => {
    const hits = [];
    for (const [user, path] of [
      [A.admin, '/api/students'], [A.admin, '/api/teachers'], [A.admin, '/api/fees'], [A.admin, '/api/academic/classes'], [A.admin, '/api/assistant/intro'], [A.admin, '/api/ai-usage/summary'],
      [A.studentUser, '/api/learning/context'], [A.studentUser, '/api/learning/conversations'], [A.studentUser, '/api/learning/practice'], [A.studentUser, '/api/learning/plan'], [A.studentUser, '/api/learning/progress'],
      [A.parentUser, '/api/assistant/intro'], [A.teacherUser, '/api/students'],
    ]) hits.push([path, (await api().get(path).set(auth(user))).status]);
    expect(hits.filter(([, s]) => s >= 500)).toEqual([]);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(await AiUsage.countDocuments({})).toBe(0);
    const s = (await api().get('/api/ai-usage/summary').set(auth(A.admin))).body.data;
    expect(s).toMatchObject({ zeroUse: true, totals: { calls: 0, tokens: 0, costEstimate: 0 }, byFeature: [], alerts: [] });
  });

  test('requests answered without a model (a fixed reply, a notes-revision request with no notes) cost nothing', async () => {
    await events(A.studentUser, { message: 'teacher ko bolo ki mera doubt clear kare' });
    await events(A.studentUser, { message: 'Mujhe mere notes revise karwa do' });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(await AiUsage.countDocuments({})).toBe(0);
  });
});

describe('metering', () => {
  test('a tutor answer is recorded with the provider\'s own token counts, and no question or answer text is stored', async () => {
    streams.push(['Plants make food from light.']);
    const { ev } = await events(A.studentUser, { message: 'What is photosynthesis? My secret word is zebra123' });
    expect(finalOf(ev)).toBeTruthy();
    const [row] = await rows({ feature: 'tutor' });
    expect(row).toMatchObject({ provider: 'azure', model: 'gpt-test', inputTokens: 123, outputTokens: 45, tokensEstimated: false, cached: false, ok: true, costEstimate: null });
    expect(row.ms).toBeGreaterThanOrEqual(0);
    expect(String(row.user)).toBe(String(A.studentUser._id));
    expect(JSON.stringify(row)).not.toMatch(/zebra123|photosynthesis|Plants make/i);
    expect(JSON.stringify(row)).not.toMatch(/"k"|api-key/i);
  });

  test('when the provider reports no tokens, the figures are estimates and say so', async () => {
    streamUsage = null;
    streams.push(['A short answer here.']);
    await events(A.studentUser, { message: 'What is gravity?' });
    const [row] = await rows({ feature: 'tutor' });
    expect(row.tokensEstimated).toBe(true);
    expect(row.inputTokens).toBeGreaterThan(0);
    expect(row.outputTokens).toBe(Math.ceil('A short answer here.'.length / 4));
  });

  test('every call behind one action is recorded under its own feature: tutor, calculation check, practice, its verification and marking', async () => {
    streams.push(['MP = 45 ÷ 0.9 = 50\n**Answer:** ₹50.']);
    jsons.push({ checks: [{ type: 'value', expr: '45 / 0.9', answer: '50' }] });
    await events(A.studentUser, { message: 'A pen costs ₹45 after a 10% discount. What was the marked price?' });
    jsons.push({ questions: [
      { format: 'mcq', prompt: 'What is 3/4 + 1/8?', options: ['7/8', '4/12', '1/2', '5/8'], answer: '7/8', hint: 'h', solution: 's' },
      { format: 'short', prompt: 'What does the denominator tell you?', answer: 'The number of equal parts.', points: ['equal parts'], hint: 'h', solution: 's' },
    ] });
    jsons.push({ answers: [{ n: 1, option: '7/8' }] });
    const set = (await api().post('/api/learning/practice').set(auth(A.studentUser)).send({ subject: 'Mathematics', topic: 'Fractions', count: 2, formats: ['mcq', 'short'] })).body.data;
    jsons.push({ verdict: 'correct', feedback: 'Right.' });
    await api().post(`/api/learning/practice/${set._id}/answer`).set(auth(A.studentUser)).send({ questionId: set.questions[1].id, answer: 'how many equal parts' });
    const byFeature = Object.fromEntries((await rows()).map((r) => [r.feature, r.requests]));
    expect(byFeature).toEqual({ tutor: 1, tutor_verify: 1, practice: 1, practice_verify: 1, practice_mark: 1 });
  });

  test('a failed provider call is recorded as a failed request with no tokens claimed; the student is told honestly', async () => {
    global.fetch = jest.fn(async () => ({ ok: false, status: 500, text: async () => 'down', headers: { get: () => null } }));
    const { ev } = await events(A.studentUser, { message: 'What is gravity?' });
    expect(ev.find((e) => e.type === 'error')).toMatchObject({ code: 'AI_FAILED' });
    const [row] = await rows();
    expect(row).toMatchObject({ feature: 'tutor', ok: false, tokensEstimated: true, inputTokens: 0, outputTokens: 0 });
  });

  test('the cost is an estimate from configured prices; with no price it is "not priced", never a guess', async () => {
    streams.push(['One.']);
    await events(A.studentUser, { message: 'What is gravity?' });
    let s = (await api().get('/api/ai-usage/summary').set(auth(A.admin))).body.data;
    expect(s.cost).toMatchObject({ kind: 'estimate', pricesConfigured: false, estimated: null, actualProviderBilling: null, unpricedCalls: 1 });
    expect(s.cost.note).toMatch(/not the provider's invoice/);

    process.env.AI_PRICING = PRICES;
    streams.push(['Two.']);
    await events(A.studentUser, { message: 'What is friction?' });
    s = (await api().get('/api/ai-usage/summary').set(auth(A.admin))).body.data;
    const expected = (123 / 1e6) * 1000 + (45 / 1e6) * 2000; // 0.213
    expect(s.cost).toMatchObject({ pricesConfigured: true, currency: 'USD', unpricedCalls: 1 });
    expect(s.cost.estimated).toBeCloseTo(expected, 6);
    expect(s.totals).toMatchObject({ calls: 2, tokens: 2 * 168 });
    expect(s.byFeature[0]).toMatchObject({ feature: 'tutor', calls: 2 });
  });
});

describe('limits and alerts', () => {
  test('a token limit stops paid calls before they start (429, nothing sent to the provider); Ask falls back to keywords', async () => {
    streams.push(['One.']);
    await events(A.studentUser, { message: 'What is gravity?' }); // 168 tokens used
    await setLimits(A.school, { aiTokensPerMonth: 100 });
    calls.length = 0;
    const res = await chat(A.studentUser, { message: 'What is friction?' });
    expect(res.status).toBe(429);
    expect(res.body).toBeDefined();
    const json = (await api().post('/api/learning/chat').set(auth(A.studentUser)).send({ message: 'What is friction?' }));
    expect(json.body).toMatchObject({ success: false, code: 'AI_LIMIT', limit: 'tokens' });
    expect(json.body.message).toMatch(/monthly AI allowance has been used/);
    expect(calls).toHaveLength(0);

    // Ask: a study question is answered by keywords, no model call, and says so.
    const ask = await api().post('/api/assistant/ask').set(auth(A.studentUser)).send({ message: 'explain photosynthesis' });
    expect(ask.status).toBe(200);
    expect(calls).toHaveLength(0);
    expect(ask.body.data.replies[0].text).toMatch(/not available|not been sent/);
    const s = (await api().get('/api/ai-usage/summary').set(auth(A.admin))).body.data;
    expect(s.alerts).toEqual([expect.objectContaining({ level: 'critical' })]);
  });

  test('a warning appears at the threshold, before anything is blocked', async () => {
    streams.push(['One.']);
    await events(A.studentUser, { message: 'What is gravity?' }); // 168 tokens
    await setLimits(A.school, { aiTokensPerMonth: 200 }); // 84% used (AI_WARN_AT default 80%)
    const s = (await api().get('/api/ai-usage/summary').set(auth(A.admin))).body.data;
    expect(s.alerts).toEqual([expect.objectContaining({ level: 'warning', message: expect.stringContaining('84% used') })]);
    streams.push(['Two.']);
    expect((await chat(A.studentUser, { message: 'What is friction?' })).status).toBe(200);
  });

  test('a cost budget is enforced when prices are configured, and reported as not enforceable when they are not', async () => {
    await setLimits(A.school, { aiBudgetPerMonth: 0.2 });
    let s = (await api().get('/api/ai-usage/summary').set(auth(A.admin))).body.data;
    expect(s.limits).toEqual([expect.objectContaining({ key: 'budget', state: 'unenforceable' })]);
    expect(s.alerts[0].level).toBe('info');
    expect(s.alerts[0].message).toMatch(/not enforced/);

    process.env.AI_PRICING = PRICES;
    streams.push(['One.']);
    expect((await chat(A.studentUser, { message: 'What is gravity?' })).status).toBe(200); // 0.213 > 0.2
    calls.length = 0;
    const res = await api().post('/api/learning/chat').set(auth(A.studentUser)).send({ message: 'What is friction?' });
    expect(res.status).toBe(429);
    expect(res.body.message).toMatch(/monthly AI budget has been used/);
    expect(calls).toHaveLength(0);
  });

  test('a quota for one feature blocks only that feature', async () => {
    await setLimits(A.school, { 'featureQuotas.tutor': 1 });
    streams.push(['One.']);
    expect((await chat(A.studentUser, { message: 'What is gravity?' })).status).toBe(200);
    const blocked = await api().post('/api/learning/chat').set(auth(A.studentUser)).send({ message: 'What is friction?' });
    expect(blocked.status).toBe(429);
    expect(blocked.body.message).toMatch(/limit for AI Tutor has been reached/);
    jsons.push({ questions: [{ format: 'numeric', prompt: 'Write 3/4 as a decimal.', answer: '0.75', hint: 'h', solution: 's', check: { type: 'value', expr: '3/4', answer: '0.75' } }] });
    expect((await api().post('/api/learning/practice').set(auth(A.studentUser)).send({ subject: 'Mathematics', formats: ['numeric'] })).status).toBe(201);
  });

  test('the plan owner can set the new limits per school; they reach the school\'s entitlements', async () => {
    const owner = require('./helpers');
    expect(owner).toBeDefined();
    await setLimits(A.school, { aiBudgetPerMonth: 5, aiTokensPerMonth: 1000, 'featureQuotas.ask': 50 });
    const s = (await api().get('/api/ai-usage/summary').set(auth(A.admin))).body.data;
    expect(s.limits.map((l) => l.key).sort()).toEqual(['budget', 'quota_ask', 'tokens']);
    expect(s.limits.find((l) => l.key === 'tokens')).toMatchObject({ limit: 1000, used: 0, state: 'ok' });
  });

  test('one answer at a time per student: a second request during an answer is refused, and a finished answer frees the slot', async () => {
    hold = {}; hold.promise = new Promise((resolve) => { hold.release = resolve; });
    streams.push(['First part. ', 'Second part.']);
    const first = chat(A.studentUser, { message: 'What is gravity?' }).then((r) => r); // .then() sends it (superagent is lazy)
    await new Promise((r) => setTimeout(r, 400));
    const second = await api().post('/api/learning/chat').set(auth(A.studentUser)).send({ message: 'And friction?' });
    expect(second.status).toBe(429);
    expect(second.body.message).toMatch(/wait for the current answer/);
    hold.release();
    expect((await first).status).toBe(200);
    hold = null;
    streams.push(['Done.']);
    expect((await chat(A.studentUser, { message: 'And friction?' })).status).toBe(200);
  });
});

describe('safe caching of generic answers', () => {
  test('the same standard question in the same class is answered without a model call; another school never gets it', async () => {
    streams.push(['Gravity pulls things towards the Earth. This is a general explanation, not from your school notes.']);
    const first = await events(A.studentUser, { message: 'What is gravity?' });
    expect(finalOf(first.ev).cached).toBeUndefined();
    expect(calls).toHaveLength(1);

    calls.length = 0;
    const second = await events(A.otherStudentUser, { message: '  what is GRAVITY?? ' }); // another student, same school; class 10-B has no notes either
    expect(finalOf(second.ev)).toMatchObject({ cached: true, provider: null });
    expect(calls).toHaveLength(0);
    expect(second.ev.find((e) => e.type === 'meta').cached).toBe(true);
    const cachedRows = await rows({ cached: true });
    expect(cachedRows).toEqual([expect.objectContaining({ feature: 'tutor', inputTokens: 0, outputTokens: 0, costEstimate: 0 })]);

    // Another school with the same class and question: a fresh model call, its own usage.
    streams.push(['Gravity answer for Beta.']);
    await events(B.studentUser, { message: 'What is gravity?' });
    expect(calls).toHaveLength(1);
    expect(await AiUsage.countDocuments({ school: B.school._id, cached: false })).toBe(1);
  });

  test('new notes for the class drop the cached answer; follow-ups and answers built from school notes are never cached', async () => {
    streams.push(['General gravity answer.']);
    await events(A.studentUser, { message: 'What is gravity?' });
    calls.length = 0;
    await addNote(A.school._id, { title: 'Gravity notes', subject: 'Science', text: 'Gravity is the force by which the Earth pulls objects towards its centre. Weight is the force of gravity on a body.' });
    streams.push(['Gravity answer from notes [S1].']);
    const again = await events(A.studentUser, { message: 'What is gravity?' });
    expect(calls).toHaveLength(1); // not served from the cache
    expect(finalOf(again.ev).used.map((u) => u.title)).toEqual(['Gravity notes']);
    // Asked again: the answer used school notes, so it was not stored.
    calls.length = 0;
    streams.push(['Gravity answer from notes again [S1].']);
    await events(A.studentUser, { message: 'What is gravity?' });
    expect(calls).toHaveLength(1);

    // A follow-up in a conversation is never cached.
    const first = await events(A.studentUser, { message: 'What is friction?' });
    const conversationId = finalOf(first.ev).conversationId;
    calls.length = 0; streams.push(['More about friction.']);
    await events(A.studentUser, { message: 'What is friction?', conversationId });
    expect(calls).toHaveLength(1);
  });

  test('an answer whose calculation failed its check is not cached', async () => {
    streams.push(['3/4 + 1/8 = 4/12\n```check\n{"type":"value","expr":"3/4 + 1/8","answer":"4/12"}\n```']);
    await events(A.studentUser, { message: 'add 3/4 and 1/8' });
    calls.length = 0; streams.push(['3/4 + 1/8 = 7/8\n```check\n{"type":"value","expr":"3/4 + 1/8","answer":"7/8"}\n```']);
    const second = await events(A.studentUser, { message: 'add 3/4 and 1/8' });
    expect(calls).toHaveLength(1);
    expect(finalOf(second.ev).confidence.level).toBe('high');
  });
});

describe('what the student asks for: intent, context and language', () => {
  test('"revise my notes" revises the student\'s own notes (no search words needed) and cites them; with no notes it says so and calls no model', async () => {
    const empty = await events(A.studentUser, { message: 'Mujhe mere notes revise karwa do' });
    expect(finalOf(empty.ev).text).toMatch(/koi notes upload nahi hue/);
    expect(finalOf(empty.ev).intent).toBe('revise_notes');
    expect(calls).toHaveLength(0);

    await addNote(A.school._id);
    await addNote(A.school._id, { title: 'Class 9 notes', cls: '9', subject: 'Science', text: 'Class nine only notes about the periodic table and valency of elements.' });
    streams.push(['Photosynthesis key points: plants make glucose using light [S1].\n\nWhich gas do plants take in?']);
    const { ev } = await events(A.studentUser, { message: 'Mujhe mere notes revise karwa do' });
    const user = calls[0].messages[calls[0].messages.length - 1].content;
    expect(user).toMatch(/REVISION REQUEST/);
    expect(user).toMatch(/Chapter 6: Photosynthesis/);
    expect(user).not.toMatch(/periodic table/); // another class's notes are never revised
    expect(finalOf(ev)).toMatchObject({ intent: 'revise_notes', used: [expect.objectContaining({ title: 'Chapter 6: Photosynthesis' })] });
    expect(await AssistantTicket.countDocuments({})).toBe(0);
  });

  test('notes that exist but have no readable text yet are not reported as "not uploaded"; no model is called', async () => {
    await Note.create({ school: A.school._id, title: 'Scanned chapter', subject: 'Science', class: '10', section: 'A', type: 'Notes', processing: { status: 'pending' } });
    const { ev } = await events(A.studentUser, { message: 'Mujhe mere notes revise karwa do' });
    expect(finalOf(ev).text).toMatch(/ready nahi/);
    expect(finalOf(ev).text).not.toMatch(/koi notes upload nahi hue/);
    expect(calls).toHaveLength(0);
  });

  test('a request to contact a teacher is answered with what the tutor can do, and nothing is created or sent', async () => {
    const { ev } = await events(A.studentUser, { message: 'Tell my teacher I could not understand algebra' });
    expect(finalOf(ev)).toMatchObject({ intent: 'contact_teacher', provider: null });
    expect(finalOf(ev).text).toMatch(/cannot contact your teacher/);
    expect(await AssistantTicket.countDocuments({})).toBe(0);
    expect(calls).toHaveLength(0);
  });

  test('"ask me 5 questions on this" uses the conversation\'s topic and offers a checked practice set; without a topic it asks which', async () => {
    const none = await events(A.studentUser, { message: 'Ab isi concept ke 5 questions poochho' });
    expect(finalOf(none.ev).text).toMatch(/kis topic par/);
    expect(finalOf(none.ev).suggest).toBeUndefined();

    streams.push(['Photosynthesis is how plants make food from light.\n```context\n{"subject":"Science","topic":"Photosynthesis"}\n```']);
    const first = await events(A.studentUser, { message: 'Explain photosynthesis' });
    const f = finalOf(first.ev);
    expect(f.topic).toEqual({ subject: 'Science', topic: 'Photosynthesis' });
    expect(f.text).not.toMatch(/context|```/);
    const conversationId = f.conversationId;
    expect((await LearningConversation.findById(conversationId)).topic).toMatchObject({ subject: 'Science', topic: 'Photosynthesis' });

    calls.length = 0;
    const q = await events(A.studentUser, { message: 'Ab isi concept ke 5 questions poochho', conversationId });
    expect(finalOf(q.ev).suggest).toEqual({ action: 'practice', subject: 'Science', topic: 'Photosynthesis', count: 5 });
    expect(calls).toHaveLength(0); // the offer needs no model call; the practice set itself is the paid step
  });

  test('"this" and "explain it again" carry the topic: it is sent with the follow-up and used to search the notes', async () => {
    await addNote(A.school._id);
    streams.push(['Photosynthesis explained [S1].\n```context\n{"subject":"Science","topic":"Photosynthesis"}\n```']);
    const first = await events(A.studentUser, { message: 'Explain photosynthesis' });
    const conversationId = finalOf(first.ev).conversationId;
    calls.length = 0;
    streams.push(['Simpler: plants cook food using sunlight [S1].']);
    const follow = await events(A.studentUser, { message: 'aur simple samjhao', conversationId });
    const user = calls[0].messages[calls[0].messages.length - 1].content;
    expect(user).toMatch(/CONVERSATION TOPIC SO FAR[^\n]*Science: Photosynthesis/);
    expect(calls[0].messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(user).toMatch(/Chapter 6: Photosynthesis/); // the notes were found although "aur simple samjhao" has no topic words
    expect(finalOf(follow.ev).used).toHaveLength(1);
  });

  test('a revision-plan request points to the planner, not to a ticket or a model', async () => {
    const { ev } = await events(A.studentUser, { message: 'revision plan banao' });
    expect(finalOf(ev)).toMatchObject({ intent: 'plan', suggest: { action: 'planner' } });
    expect(calls).toHaveLength(0);
  });

  test('the answer language follows the student, and a short reply keeps the conversation\'s language', () => {
    expect(resolveLanguage('What is gravity?', null)).toBe('en');
    expect(resolveLanguage('fractions ko add kaise karte hain', null)).toBe('hinglish');
    expect(resolveLanguage('गुरुत्वाकर्षण क्या है?', 'en')).toBe('hi');
    expect(resolveLanguage('Ab isi concept ke 5 questions poochho', null)).toBe('hinglish'); // Hindi words around English school words
    expect(resolveLanguage('Ye samajh nahi aaya, aur easy way mein samjhao', null)).toBe('hinglish');
    expect(resolveLanguage('Give me another example', null)).toBe('en');
    expect(resolveLanguage('ok next', 'hinglish')).toBe('hinglish'); // a two-word English message in a Hinglish chat
    expect(resolveLanguage('Please explain the second step of the solution in detail', 'hinglish')).toBe('en'); // a full English sentence switches
  });

  test('an explanation and a rendered concept map or two-line graph pass validation; scripts are dropped', async () => {
    streams.push(['Here it is.\n```diagram\n{"type":"conceptmap","center":"Photosynthesis","branches":[{"label":"Needs","children":["Light","Water"]},{"label":"Makes","children":["Glucose"]}]}\n```']);
    let { ev } = await events(A.studentUser, { message: 'give me a concept map of photosynthesis' });
    expect(finalOf(ev).diagrams[0]).toMatchObject({ type: 'conceptmap', alt: expect.stringContaining('Concept map of Photosynthesis') });
    streams.push(['Both graphs.\n```diagram\n{"type":"graph","series":[{"expr":"x","label":"y = x"},{"expr":"x^2","label":"y = x²"}],"xMin":-2,"xMax":2,"xLabel":"x","yLabel":"y"}\n```']);
    ({ ev } = await events(A.studentUser, { message: 'plot y = x and y = x squared' }));
    expect(finalOf(ev).diagrams[0].series.map((s) => s.label)).toEqual(['y = x', 'y = x²']);
    streams.push(['Bad.\n```diagram\n{"type":"graph","series":[{"expr":"process.exit()"}]}\n```']);
    ({ ev } = await events(A.studentUser, { message: 'plot something' }));
    expect(finalOf(ev).diagrams).toEqual([]);
  });
});

describe('who can see what', () => {
  test('only the school admin sees the usage summary, and only for their own school', async () => {
    streams.push(['One.']);
    await events(A.studentUser, { message: 'What is gravity?' });
    streams.push(['Other.']);
    await events(B.studentUser, { message: 'What is friction?' });
    expect((await api().get('/api/ai-usage/summary').set(auth(A.studentUser))).status).toBe(403);
    expect((await api().get('/api/ai-usage/summary').set(auth(A.teacherUser))).status).toBe(403);
    expect((await api().get('/api/ai-usage/summary').set(auth(A.parentUser))).status).toBe(403);
    expect((await api().get('/api/ai-usage/summary')).status).toBe(401);
    const a = (await api().get('/api/ai-usage/summary').set(auth(A.admin))).body.data;
    const b = (await api().get('/api/ai-usage/summary').set(auth(B.admin))).body.data;
    expect(a.totals.calls).toBe(1);
    expect(b.totals.calls).toBe(1);
    expect((await api().get('/api/ai-usage/summary?month=nonsense').set(auth(A.admin))).status).toBe(400);
  });

  test('a switched-off or unconfigured provider is said plainly, with the right reason', async () => {
    process.env.ASSISTANT_AI = 'off';
    let { ev } = await events(A.studentUser, { message: 'What is gravity?' });
    expect(ev.find((e) => e.type === 'error')).toMatchObject({ code: 'AI_UNAVAILABLE', reason: 'off', message: expect.stringContaining('switched off') });
    process.env.ASSISTANT_AI = 'on'; delete process.env.AZURE_OPENAI_API_KEY;
    llm.resetForTests();
    ({ ev } = await events(A.studentUser, { message: 'What is gravity?' }));
    expect(ev.find((e) => e.type === 'error')).toMatchObject({ reason: 'no_provider', message: expect.stringContaining('No AI provider is configured') });
    const ctx = (await api().get('/api/learning/context').set(auth(A.studentUser))).body.data;
    expect(ctx.capabilities.ai).toEqual({ available: false, reason: 'no_provider' });
    expect(await AiUsage.countDocuments({})).toBe(0);
  });
});
