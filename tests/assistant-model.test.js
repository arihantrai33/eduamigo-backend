// EduAmigo Ask with a language model: stage-B routing, Hindi/Hinglish wording with the number check,
// general answers, and provider fallback (Azure OpenAI -> Gemini).

jest.mock('@google/generative-ai', () => {
  const generateContent = jest.fn();
  return {
    TaskType: {},
    __generateContent: generateContent,
    GoogleGenerativeAI: jest.fn(() => ({ getGenerativeModel: () => ({ generateContent }) })),
  };
});

const { api, connect, disconnect, clear, auth, seedSchool } = require('./helpers');
const Fee = require('../src/models/Fee');
const AssistantTicket = require('../src/models/AssistantTicket');
const llm = require('../src/assistant/llm');
const { numbersMatch } = require('../src/assistant/writer');
const { toDayKey } = require('../src/utils/dates');
const gemini = require('@google/generative-ai');

const geminiReply = (text) => ({ response: { text: () => text, usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 20 } } });
const azureReply = (content) => ({ ok: true, json: async () => ({ choices: [{ message: { content } }], usage: { prompt_tokens: 40, completion_tokens: 10 } }) });

let A;
const ENV = { ...process.env };

beforeAll(connect);
afterAll(disconnect);
beforeEach(async () => {
  await clear();
  A = await seedSchool('Alpha School');
  process.env = { ...ENV, ASSISTANT_AI: 'on', ASSISTANT_PROVIDERS: 'azure,gemini', AZURE_OPENAI_ENDPOINT: 'https://example.openai.azure.com', AZURE_OPENAI_API_KEY: 'k', AZURE_OPENAI_DEPLOYMENT: 'gpt-4.1-mini', GEMINI_API_KEY: 'g' };
  llm.resetForTests();
  gemini.__generateContent.mockReset();
  global.fetch = jest.fn();
});
afterAll(() => { process.env = ENV; });

const ask = (user, body) => api().post('/api/assistant/ask').set(auth(user)).send(typeof body === 'string' ? { message: body } : body);

describe('number check', () => {
  test('accepts reworded text with the same numbers, rejects invented or dropped amounts', () => {
    const original = 'Aarav (10-A): ₹4,500 is due, due 15 Oct 2026.';
    expect(numbersMatch(original, 'Aarav (10-A) ki ₹4,500 fees baki hai, 15 Oct 2026 tak.')).toBe(true);
    expect(numbersMatch(original, 'Aarav ki ₹5,000 fees baki hai.')).toBe(false);   // invented amount
    expect(numbersMatch(original, 'Aarav ki fees baki hai, 15 Oct tak.')).toBe(false); // amount dropped
    expect(numbersMatch(original, 'Aarav (10-A) की ₹४,५०० फीस बाकी है, 15 Oct 2026 तक।')).toBe(true); // Devanagari digits
  });
});

describe('Hinglish answers', () => {
  beforeEach(async () => {
    await Fee.create({ school: A.school._id, studentId: A.student._id, feeType: 'Tuition', amount: 4500, dueDate: new Date(toDayKey(new Date()).getTime() + 5 * 86400000) });
  });

  test('a Hinglish question gets a Hinglish answer when the numbers match', async () => {
    global.fetch.mockImplementation(async (url, opts) => {
      const body = JSON.parse(opts.body);
      const { replies } = JSON.parse(body.messages[1].content);
      const amount = replies[0].text.match(/₹[\d,]+/)[0];
      return azureReply(JSON.stringify({ replies: [{ id: replies[0].id, text: `Aarav ki ${amount} fees baki hai.` }] }));
    });
    const res = await ask(A.parentUser, 'meri beti ki fees kitni baki hai');
    const r = res.body.data.replies[0];
    expect(r.text).toBe('Aarav ki ₹4,500 fees baki hai.');
    expect(r.sources.length).toBeGreaterThan(0);
    expect(res.body.data.ai.provider).toBe('azure');
  });

  test('a reworded answer with a wrong number is thrown away and the record-based answer is kept', async () => {
    global.fetch.mockImplementation(async (url, opts) => {
      const { replies } = JSON.parse(JSON.parse(opts.body).messages[1].content);
      return azureReply(JSON.stringify({ replies: [{ id: replies[0].id, text: 'Aarav ki ₹450 fees baki hai.' }] }));
    });
    const res = await ask(A.parentUser, 'meri beti ki fees kitni baki hai');
    expect(res.body.data.replies[0].text).toContain('₹4,500 is due');
  });
});

// Answers each kind of call the assistant makes, by what the call asks for.
function mockModel({ understand, general, rewrite } = {}) {
  global.fetch.mockImplementation(async (url, opts) => {
    const system = JSON.parse(opts.body).messages[0].content;
    if (system.includes('split it into the separate questions')) return azureReply(JSON.stringify({ questions: understand }));
    if (system.includes('reword answers')) return azureReply(JSON.stringify(rewrite || { replies: [] }));
    return azureReply(general || 'ok');
  });
}
const part = (over) => ({ text: 'x', topic: 'fees', confidence: 0.95, alternative: null, kind: 'ask', urgent: false, person: null, class: null, ...over });

describe('the model reads the message first', () => {
  test('a school question no topic covers is offered to the office, and a ticket only if the person agrees', async () => {
    mockModel({ understand: [part({ text: 'school timing kya hai', topic: 'school_other' })] });
    const res = await ask(A.parentUser, 'school timing kya hai');
    const r = res.body.data.replies[0];
    expect(r.action).toBe('no_data');
    expect(r.options[0]).toMatchObject({ type: 'handoff' });
    expect(await AssistantTicket.countDocuments({})).toBe(0);

    const t = await ask(A.parentUser, { message: 'Ask the school office', choice: { type: 'handoff', value: 'office' }, conversationId: res.body.data.conversationId });
    expect(t.body.data.replies[0].action).toBe('handoff');
    expect(await AssistantTicket.countDocuments({ reason: 'not_covered' })).toBe(1);
  });

  test('an urgent concern the safety words miss is still handed off as urgent', async () => {
    mockModel({ understand: [part({ text: 'conductor uncle ne galat tarike se pakda', topic: 'transport', urgent: true })] });
    const res = await ask(A.parentUser, 'conductor uncle ne galat tarike se pakda');
    expect(res.body.data.replies[0].action).toBe('handoff');
    expect((await AssistantTicket.findOne({})).priority).toBe('high');
  });

  test('making a complaint, asking for a person and asking about complaints are told apart without keywords', async () => {
    mockModel({ understand: [part({ text: 'canteen ka khana kharab hai, kuch karo', topic: 'school_other', kind: 'complaint' })] });
    const filed = await ask(A.parentUser, 'canteen ka khana kharab hai, kuch karo');
    expect(filed.body.data.replies[0].action).toBe('handoff');
    expect(await AssistantTicket.findOne({ reason: 'complaint' })).toMatchObject({ priority: 'normal' });

    mockModel({ understand: [part({ text: 'meri beti ke baare mein school ne kuch likha hai kya', topic: 'general', kind: 'complaint_inquiry' })] });
    const asked = await ask(A.parentUser, 'meri beti ke baare mein school ne kuch likha hai kya');
    expect(asked.body.data.replies[0]).toMatchObject({ action: 'no_data' });
    expect(await AssistantTicket.countDocuments({})).toBe(1);

    mockModel({ understand: [part({ text: 'principal sahab se milna hai', topic: 'general', kind: 'human' })] });
    const human = await ask(A.parentUser, 'principal sahab se milna hai');
    expect(human.body.data.replies[0].action).toBe('handoff');
    expect(await AssistantTicket.countDocuments({ reason: 'requested' })).toBe(1);
  });

  test('a message with several questions is split by the model and each one is answered', async () => {
    mockModel({ understand: [part({ text: 'fees kitni baki hai', topic: 'fees' }), part({ text: 'kal ka timetable', topic: 'timetable' })] });
    const res = await ask(A.studentUser, 'fees kitni baki hai or kal ka timetable');
    expect(res.body.data.replies.map((r) => r.domain)).toEqual(['fees', 'timetable']);
  });

  test('a teacher named in the question gets that teacher\'s periods, whatever the spelling or wording', async () => {
    const Timetable = require('../src/models/Timetable');
    await A.teacher.constructor.updateOne({ _id: A.teacher._id }, { name: 'Ramesh Kumar' });
    await Timetable.create({ school: A.school._id, class: '10', section: 'A', day: 'Monday', periods: [{ periodNo: 3, subject: 'Mathematics', startTime: '09:20', endTime: '10:00', teacher: A.teacher._id }] });
    mockModel({ understand: [part({ text: 'rmesh ji kab padhate hain hamein', topic: 'timetable', person: 'rmesh' })] });
    const res = await ask(A.studentUser, 'rmesh ji kab padhate hain hamein');
    expect(res.body.data.replies[0].text).toContain('Ramesh Kumar takes Mathematics');
  });

  test('the model\'s confidence goes through the same gate: unsure topics are asked, not guessed', async () => {
    mockModel({ understand: [part({ text: 'schedule', topic: 'timetable', confidence: 0.55, alternative: 'exams' })] });
    const res = await ask(A.studentUser, 'schedule');
    const r = res.body.data.replies[0];
    expect(r.action).toBe('clarify');
    expect(r.options.map((o) => o.value)).toEqual(expect.arrayContaining(['timetable', 'exams']));
  });

  test('a topic the asker cannot use, picked by the model, is offered to the school office instead', async () => {
    mockModel({ understand: [part({ text: 'mera pocket money kab milega', topic: 'hr' })] });
    const res = await ask(A.parentUser, 'mera pocket money kab milega');
    const r = res.body.data.replies[0];
    expect(r.action).toBe('no_data');
    expect(r.options.map((o) => o.type)).toEqual(['handoff']);
  });

  test('general questions get a short model answer', async () => {
    mockModel({ understand: [part({ text: 'what is photosynthesis', topic: 'general' })], general: 'Photosynthesis is how plants make food from sunlight, water and carbon dioxide.' });
    const res = await ask(A.studentUser, 'what is photosynthesis');
    expect(res.body.data.replies[0]).toMatchObject({ domain: 'general', action: 'answer' });
    expect(res.body.data.replies[0].text).toContain('Photosynthesis');
  });

  test('safety words never wait for the model', async () => {
    const res = await ask(A.parentUser, 'Bus mein kisi ne bachche ko maara');
    expect(res.body.data.replies[0].action).toBe('handoff');
    expect(global.fetch).not.toHaveBeenCalledWith(expect.stringContaining('chat/completions'), expect.objectContaining({ body: expect.stringContaining('split it into') }));
  });

  test('if the model cannot be reached the keyword path still answers', async () => {
    global.fetch.mockResolvedValue({ ok: false, status: 503, text: async () => 'busy' });
    gemini.__generateContent.mockRejectedValue(new Error('down'));
    await Fee.create({ school: A.school._id, studentId: A.student._id, feeType: 'Tuition', amount: 2000, dueDate: new Date() });
    const res = await ask(A.parentUser, 'fees kitni baki hai');
    expect(res.body.data.replies[0].text).toContain('₹2,000');
  });
});

describe('without a model, words decide (fallback)', () => {
  test('a tie between two topics is asked', async () => {
    process.env.ASSISTANT_AI = 'off';
    const res = await ask(A.teacherUser, 'leave status?');
    expect(res.body.data.replies[0].action).toBe('clarify');
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('provider fallback', () => {
  test('when Azure fails, Gemini answers; after three failures Azure is skipped for a while', async () => {
    global.fetch.mockResolvedValue({ ok: false, status: 503, text: async () => 'busy' });
    gemini.__generateContent.mockResolvedValue(geminiReply('{"domain":"general","confidence":0.9}'));

    for (let i = 0; i < 3; i += 1) {
      const out = await llm.complete({ system: 's', user: `q${i}`, json: true });
      expect(out.provider).toBe('gemini');
    }
    expect(global.fetch).toHaveBeenCalledTimes(3);
    await llm.complete({ system: 's', user: 'q4', json: true });
    expect(global.fetch).toHaveBeenCalledTimes(3); // Azure cooling off
    expect(llm.status().providers.find((p) => p.name === 'azure').coolingOff).toBe(true);
  });

  test('identical requests are served from the cache', async () => {
    global.fetch.mockResolvedValue(azureReply('ok'));
    await llm.complete({ system: 's', user: 'same' });
    const second = await llm.complete({ system: 's', user: 'same' });
    expect(second.cached).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('if every model fails, the assistant still answers from the records', async () => {
    global.fetch.mockResolvedValue({ ok: false, status: 500, text: async () => 'down' });
    gemini.__generateContent.mockRejectedValue(new Error('down'));
    await Fee.create({ school: A.school._id, studentId: A.student._id, feeType: 'Tuition', amount: 3000, dueDate: new Date() });
    const res = await ask(A.parentUser, 'fees kitni baki hai');
    expect(res.status).toBe(200);
    expect(res.body.data.replies[0].text).toContain('₹3,000');
  });
});
