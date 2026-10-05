// UnifiedAI as an organization assistant: it remembers the conversation, treats tickets as a lifecycle (not one ticket per
// message), writes professional hand-offs for staff, decides priority by policy, and never claims an action it could not verify.
// The model is scripted (it returns what a good reading of each message would be); everything else is the real code and database.

jest.mock('@google/generative-ai', () => ({ TaskType: {}, GoogleGenerativeAI: jest.fn(() => ({ getGenerativeModel: () => ({ generateContent: jest.fn() }) })) }));

const { api, connect, disconnect, clear, auth, seedSchool, makeUser } = require('./helpers');
const AssistantTicket = require('../src/models/AssistantTicket');
const Notification = require('../src/models/Notification');
const Counter = require('../src/models/Counter');
const Teacher = require('../src/models/Teacher');
const Timetable = require('../src/models/Timetable');
const Fee = require('../src/models/Fee');
const notify = require('../src/services/notify');
const llm = require('../src/assistant/llm');
const actions = require('../src/assistant/actions');
const { toDayKey } = require('../src/utils/dates');

const azureReply = (content) => ({ ok: true, json: async () => ({ choices: [{ message: { content } }], usage: { prompt_tokens: 40, completion_tokens: 10 } }) });
const ENV = { ...process.env };
let A; let seen;

// understand: what the model returns for the message; seen collects every understand prompt so tests can check the context sent.
function scriptedModel(understand) {
  seen = [];
  global.fetch.mockImplementation(async (url, opts) => {
    const body = JSON.parse(opts.body);
    const system = body.messages[0].content;
    if (system.includes('split it into the separate questions')) {
      seen.push(body.messages[1].content);
      const q = typeof understand === 'function' ? understand(body.messages[1].content) : understand;
      return azureReply(JSON.stringify({ language: 'hinglish', questions: q }));
    }
    if (system.includes('For each item you get the user')) {
      const { items } = JSON.parse(body.messages[1].content);
      return azureReply(JSON.stringify({ replies: items.map((i) => ({ id: i.id, answered: true, text: i.standardAnswer })) }));
    }
    return azureReply(JSON.stringify({ replies: [] })); // the writer: keeps the standard wording
  });
}
const part = (over) => ({ text: 'x', topic: 'exams', confidence: 0.95, alternative: null, kind: 'forward', safety: 'none', person: null, class: null, about: 'self', ticket: null, brief: null, ...over });
const ask = (user, body) => api().post('/api/assistant/ask').set(auth(user)).send(typeof body === 'string' ? { message: body } : body);
const tickets = () => AssistantTicket.find({}).sort({ createdAt: 1 });

beforeAll(connect);
afterAll(disconnect);
beforeEach(async () => {
  await clear();
  A = await seedSchool('Alpha School');
  process.env = { ...ENV, ASSISTANT_AI: 'on', ASSISTANT_PROVIDERS: 'azure', AZURE_OPENAI_ENDPOINT: 'https://example.openai.azure.com', AZURE_OPENAI_API_KEY: 'k', AZURE_OPENAI_DEPLOYMENT: 'gpt-4.1-mini' };
  llm.resetForTests();
  global.fetch = jest.fn();
  await Teacher.updateOne({ _id: A.teacher._id }, { name: 'Ramesh Kumar' });
  await Timetable.create({ school: A.school._id, class: '10', section: 'A', day: 'Monday', periods: [{ periodNo: 3, subject: 'Mathematics', startTime: '09:20', endTime: '10:00', teacher: A.teacher._id }] });
});
afterEach(() => jest.restoreAllMocks());
afterAll(() => { process.env = ENV; });

const BRIEF = { title: 'Mathematics marks query, Aarav 10-A', summary: 'The parent believes Aarav\'s Mathematics marks in Unit Test 1 were entered incorrectly.', request: 'Please re-check the marks and reply to the parent.' };

describe('professional hand-off', () => {
  test('staff get a professional English brief, not the raw Hinglish; the original is kept for audit; priority comes from policy', async () => {
    const raw = 'sir maths me mere bete ke number galat chadhe hai plz dekho';
    scriptedModel([part({ text: raw, kind: 'complaint', subject: 'Maths', brief: BRIEF })]);
    const res = await ask(A.parentUser, raw);
    const [t] = await tickets();
    expect(t).toMatchObject({ title: BRIEF.title, summary: BRIEF.summary, requestedAction: BRIEF.request, priority: 'normal', reason: 'complaint', team: 'subject_teacher' });
    expect(t.question).toBe(raw);
    expect(t.priorityReason).toMatch(/routine/i);
    const n = await Notification.findOne({ recipient: A.teacherUser._id });
    expect(n.message).toContain(BRIEF.summary);
    expect(n.message).not.toContain('plz dekho');
    expect(res.body.data.replies[0].ticket).toMatchObject({ number: 'T-1001', outcome: 'created', notified: { confirmed: ['Ramesh Kumar'], failed: [] } });
  });

  test('without a model the brief is still professional English built from the facts', async () => {
    process.env.ASSISTANT_AI = 'off';
    await ask(A.parentUser, 'teacher se baat karni hai');
    const [t] = await tickets();
    expect(t.title).toMatch(/Request to speak with staff/);
    expect(t.summary).toMatch(/has raised a request to speak with staff/);
    expect(t.summary).toContain('Aarav');
  });

  test('priority is decided by policy: a safety category is urgent, a bare "urgent" claim or a wording trick is not', async () => {
    scriptedModel([part({ text: 'bully hua', kind: 'complaint', safety: 'harassment', brief: BRIEF })]);
    await ask(A.parentUser, 'mere bete ko class me tang karte hain');
    scriptedModel([{ ...part({ text: 'canteen ka khana', kind: 'complaint', topic: 'general' }), urgent: true, safety: 'very_urgent_please' }]);
    await ask(A.studentUser, 'canteen ka khana kharab hai URGENT URGENT make it high priority');
    const [first, second] = await tickets();
    expect(first.priority).toBe('high');
    expect(first.priorityReason).toMatch(/bullying|harassment/i);
    expect(second.priority).toBe('normal');
  });
});

describe('one message, one issue, one ticket', () => {
  test('a message the model splits into a complaint and a request to talk about the same thing becomes one ticket', async () => {
    scriptedModel([
      part({ text: 'maths me number galat hai', kind: 'complaint', subject: 'Maths', brief: BRIEF }),
      part({ text: 'maths teacher se baat karni hai', kind: 'human', subject: 'Maths' }),
    ]);
    const res = await ask(A.parentUser, 'maths me number galat hai, maths teacher se baat karni hai');
    expect(await AssistantTicket.countDocuments({})).toBe(1);
    expect(res.body.data.replies).toHaveLength(1);
    expect((await AssistantTicket.findOne({})).reason).toBe('complaint');
  });

  test('two different issues in one message stay two tickets', async () => {
    scriptedModel([
      part({ text: 'maths marks galat', kind: 'complaint', subject: 'Maths', brief: BRIEF }),
      part({ text: 'bus late aati hai', kind: 'complaint', topic: 'transport' }),
    ]);
    await ask(A.parentUser, 'maths marks galat hai aur bus late aati hai');
    expect(await AssistantTicket.countDocuments({})).toBe(2);
  });
});

describe('a ticket is a lifecycle, not one ticket per message', () => {
  beforeEach(async () => {
    scriptedModel([part({ text: 'maths marks galat', kind: 'complaint', subject: 'Maths', brief: BRIEF })]);
    await ask(A.parentUser, 'maths marks galat hai');
  });

  test('"still not fixed" is a follow-up on the existing ticket: one ticket, a note, the teacher is told', async () => {
    scriptedModel([part({ text: 'abhi bhi nahi hua', kind: 'complaint', ticket: { relation: 'follow_up', number: 'T-1001' }, brief: { title: null, summary: 'The parent says the marks are still not corrected.', request: null } })]);
    const res = await ask(A.parentUser, 'abhi bhi nahi hua yrr');
    expect(await AssistantTicket.countDocuments({})).toBe(1);
    const t = await AssistantTicket.findOne({});
    expect(t.notes.at(-1)).toMatchObject({ kind: 'follow_up', text: 'The parent says the marks are still not corrected.' });
    expect(res.body.data.replies[0].ticket).toMatchObject({ number: 'T-1001', outcome: 'followed_up' });
    expect(res.body.data.replies[0].text).toMatch(/existing ticket T-1001/);
    expect(await Notification.countDocuments({ recipient: A.teacherUser._id })).toBe(2);
  });

  test('the same report in other words, with no model, is recognised as the same open issue', async () => {
    process.env.ASSISTANT_AI = 'off';
    const res = await ask(A.parentUser, 'maths marks galat hai teacher se baat karni hai');
    expect(await AssistantTicket.countDocuments({})).toBe(1);
    expect((await AssistantTicket.findOne({})).notes.at(-1).kind).toBe('repeat');
    expect(res.body.data.replies[0].ticket.outcome).toBe('repeat');
    expect(res.body.data.replies[0].text).toMatch(/already have an open ticket/);
  });

  test('a model that attaches an unrelated issue to an existing ticket is overruled: different topic means a new ticket, not a note to the wrong teacher', async () => {
    scriptedModel([part({ text: 'bus roz late aati hai', kind: 'complaint', topic: 'transport', ticket: { relation: 'follow_up', number: 'T-1001' } })]);
    const res = await ask(A.parentUser, 'bus roz late aati hai');
    expect(res.body.data.replies[0].ticket).toMatchObject({ number: 'T-1002', outcome: 'created' });
    expect((await AssistantTicket.findOne({ number: 'T-1001' })).notes).toHaveLength(0);
  });

  test('a different issue is a new ticket', async () => {
    scriptedModel([part({ text: 'bus late', kind: 'complaint', topic: 'transport', ticket: { relation: 'new', number: null } })]);
    await ask(A.parentUser, 'bus roz late aati hai');
    expect(await AssistantTicket.countDocuments({})).toBe(2);
  });

  test('escalation raises the priority by policy, brings in the admins once, and cannot be repeated', async () => {
    scriptedModel([part({ text: 'escalate', kind: 'complaint', ticket: { relation: 'escalate', number: 'T-1001' } })]);
    const res = await ask(A.parentUser, 'please escalate, koi sun nahi raha');
    const t = await AssistantTicket.findOne({});
    expect(t.priority).toBe('high');
    expect(t.assignees.map(String)).toContain(String(A.admin._id));
    expect(res.body.data.replies[0].ticket.outcome).toBe('escalated');
    expect(await Notification.countDocuments({ recipient: A.admin._id })).toBe(1);

    const again = await ask(A.parentUser, 'escalate it again');
    expect(again.body.data.replies[0].action).toBe('blocked');
    expect(again.body.data.replies[0].text).toMatch(/already marked urgent/);
  });

  test('a resolved ticket is reopened when the problem is back; one resolved long ago is not', async () => {
    const t = await AssistantTicket.findOne({});
    await AssistantTicket.updateOne({ _id: t._id }, { status: 'resolved', resolvedAt: new Date() });
    scriptedModel([part({ text: 'phir wahi problem', kind: 'complaint', ticket: { relation: 'reopen', number: 'T-1001' } })]);
    const res = await ask(A.parentUser, 'phir wahi problem aa gayi');
    expect(res.body.data.replies[0].ticket.outcome).toBe('reopened');
    const reopened = await AssistantTicket.findOne({});
    expect(reopened).toMatchObject({ status: 'open', reopenedCount: 1 });

    await AssistantTicket.updateOne({ _id: t._id }, { status: 'resolved', resolvedAt: new Date(Date.now() - 20 * 86400000) });
    const old = await ask(A.parentUser, 'phir wahi problem aa gayi');
    expect(old.body.data.replies[0].action).toBe('blocked');
    expect(old.body.data.replies[0].text).toMatch(/more than 14 days/);
  });

  test('"what happened to my complaint?" is answered from the real ticket: status, who has it, the staff reply', async () => {
    await AssistantTicket.updateOne({}, { status: 'in_progress', $push: { notes: { by: A.teacherUser._id, kind: 'note', text: 'I have asked the exam cell to re-check.' } } });
    scriptedModel([part({ text: 'complaint ka kya hua', kind: 'ticket_status', topic: 'general' })]);
    const res = await ask(A.parentUser, 'meri complaint ka kya hua');
    const r = res.body.data.replies[0];
    expect(r.action).toBe('answer');
    expect(r.text).toContain('T-1001');
    expect(r.text).toMatch(/being worked on/);
    expect(r.text).toContain('re-check');
    expect(r.sources[0]).toMatchObject({ type: 'ticket' });
  });

  test('a ticket number the model names that belongs to someone else is ignored (RBAC at the action boundary)', async () => {
    scriptedModel([part({ text: 'update', kind: 'complaint', ticket: { relation: 'follow_up', number: 'T-1001' } })]);
    const other = await makeUser(A.school, 'parent', { name: 'Other Parent' });
    const res = await ask(other, 'T-1001 pe update do');
    // Someone else's ticket looks exactly like one that does not exist: nothing is attached to it and nothing is revealed about it.
    // (Before the lookup by number, this created a new ticket of their own that quoted the other number; now they are asked to check it.)
    expect(res.body.data.replies[0].ticket).toBeNull();
    expect(res.body.data.replies[0].text).toMatch(/could not find a ticket T-1001/i);
    expect(await AssistantTicket.countDocuments({})).toBe(1);
    expect((await AssistantTicket.findOne({ number: 'T-1001' })).notes).toHaveLength(0);
    const direct = await actions.run('ticket.follow_up', { user: other, schoolId: A.school._id }, { ticket: await AssistantTicket.findOne({ number: 'T-1001' }), text: 'hi' });
    expect(direct).toMatchObject({ ok: false, denied: true, error: 'not_yours' });
  });
});

describe('the conversation is remembered, in a bounded way', () => {
  test('the model is given the recent turns, the people just mentioned and the person\'s tickets, so "him" and "that issue" can be resolved', async () => {
    scriptedModel([part({ text: 'maths marks galat', kind: 'forward', subject: 'Maths', brief: BRIEF })]);
    const first = await ask(A.parentUser, 'maths marks galat hai');
    scriptedModel([part({ text: 'usko bhi bata do ki kal aaunga', kind: 'complaint', person: 'Ramesh Kumar', ticket: { relation: 'follow_up', number: 'T-1001' } })]);
    const res = await ask(A.parentUser, { message: 'usko bhi bata do ki kal aaunga', conversationId: first.body.data.conversationId });
    const prompt = seen[0];
    expect(prompt).toContain('People just mentioned: Ramesh Kumar');
    expect(prompt).toContain('T-1001: open');
    expect(prompt).toContain('Recent messages');
    expect(res.body.data.replies[0].ticket.outcome).toBe('followed_up');
    expect(await AssistantTicket.countDocuments({})).toBe(1);
  });

  test('only a short window of the chat is kept, never the whole transcript', async () => {
    scriptedModel([part({ text: 'hi', kind: 'ask', topic: 'general' })]);
    let conversationId;
    for (let i = 0; i < 6; i += 1) {
      const r = await ask(A.studentUser, { message: `hello ${i}`, conversationId });
      conversationId = r.body.data.conversationId;
    }
    const Conv = require('../src/models/AssistantConversation');
    const conv = await Conv.findById(conversationId);
    expect(conv.state.recent.length).toBeLessThanOrEqual(6);
    expect(seen.at(-1)).not.toContain('hello 0');
  });
});

describe('the context handed to the model', () => {
  test('the ticket raised in this chat is listed on its own, apart from the person\'s other tickets', () => {
    const conversation = require('../src/assistant/conversation');
    const mk = (number, title) => ({ number, status: 'open', title, createdAt: new Date(), sentTo: [{ name: 'Anita Verma' }] });
    const tickets = [mk('T-1014', 'English marks'), mk('T-1012', 'Maths marks'), mk('T-1009', 'Leave')];
    const text = conversation.contextFor({ state: { recent: [], people: [], tickets: [{ number: 'T-1012' }] } }, tickets, new Date());
    const [here, others] = text.split("The person's other tickets");
    expect(here).toContain('THIS chat');
    expect(here).toContain('T-1012');
    expect(here).not.toContain('T-1014');
    expect(others).toContain('T-1014');
    expect(others).not.toContain('T-1012');
  });
});

describe('the planner without a named ticket', () => {
  test('"what happened to my complaint" is about the ticket discussed in this chat, not just the newest one', () => {
    const planner = require('../src/assistant/planner');
    const mk = (number, createdAt) => ({ number, status: 'open', domain: 'exams', sentTo: [], createdAt });
    const tickets = [mk('T-1010'), mk('T-1002')];
    const chat = planner.plan({ kind: 'ticket_status' }, { tickets, text: 'meri complaint ka kya hua', inChat: ['T-1002'] });
    expect(chat.ticket.number).toBe('T-1002');
    const none = planner.plan({ kind: 'ticket_status' }, { tickets, text: 'meri complaint ka kya hua' });
    expect(none.ticket.number).toBe('T-1010');
  });
});

describe('actions are verified, so the assistant never claims what did not happen', () => {
  test('if the notification fails, the ticket is saved and the reply says it could not confirm the notification', async () => {
    jest.spyOn(notify, 'notifyUser').mockRejectedValue(new Error('push provider down'));
    scriptedModel([part({ text: 'marks', kind: 'forward', subject: 'Maths', brief: BRIEF })]);
    const res = await ask(A.parentUser, 'maths marks ke baare me baat karni hai');
    const r = res.body.data.replies[0];
    expect(await AssistantTicket.countDocuments({})).toBe(1);
    expect(r.text).toMatch(/could not confirm/i);
    expect(r.text).not.toMatch(/have been notified|has been notified/);
    expect(r.ticket.notified).toMatchObject({ confirmed: [], failed: ['Ramesh Kumar'] });
    expect((await AssistantTicket.findOne({})).notifications[0]).toMatchObject({ name: 'Ramesh Kumar', ok: false });
  });

  test('if the ticket cannot be saved, nothing is claimed, the person can retry, and the retry works', async () => {
    jest.spyOn(Counter, 'next').mockRejectedValueOnce(new Error('database busy'));
    scriptedModel([part({ text: 'marks', kind: 'forward', subject: 'Maths', brief: BRIEF })]);
    const res = await ask(A.parentUser, 'maths marks ke baare me baat karni hai');
    const r = res.body.data.replies[0];
    expect(r.action).toBe('no_data');
    expect(r.text).toMatch(/could not complete/i);
    expect(r.text).not.toMatch(/raised|ticket T-/i);
    expect(await AssistantTicket.countDocuments({})).toBe(0);
    expect(r.options[0]).toMatchObject({ type: 'handoff' });

    const retry = await ask(A.parentUser, { message: 'Try again', choice: { type: 'handoff', value: 'office' }, conversationId: res.body.data.conversationId });
    expect(retry.body.data.replies[0].ticket).toMatchObject({ number: 'T-1001', outcome: 'created' });
    expect(await AssistantTicket.countDocuments({})).toBe(1);
  });

  test('a failed action in one part of a message does not discard the answer to the other part', async () => {
    await Fee.create({ school: A.school._id, studentId: A.student._id, feeType: 'Tuition', amount: 4500, dueDate: toDayKey(new Date()) });
    jest.spyOn(Counter, 'next').mockRejectedValueOnce(new Error('database busy'));
    scriptedModel([part({ text: 'fees kitni baki hai', kind: 'ask', topic: 'fees' }), part({ text: 'maths teacher se baat karni hai', kind: 'forward', subject: 'Maths' })]);
    const res = await ask(A.parentUser, 'fees kitni baki hai aur maths teacher se baat karni hai');
    const [fees, forward] = res.body.data.replies;
    expect(fees).toMatchObject({ domain: 'fees', action: 'answer' });
    expect(fees.text).toContain('4,500');
    expect(forward.action).toBe('no_data');
  });

  test('every action reports what it did through its contract (authorize, validate, execute, verify)', async () => {
    const names = actions.catalog().map((a) => a.name);
    expect(names).toEqual(expect.arrayContaining(['ticket.create', 'ticket.follow_up', 'ticket.repeat', 'ticket.escalate', 'ticket.reopen', 'ticket.status']));
    const bad = await actions.run('ticket.create', { user: A.parentUser, role: 'parent', schoolId: A.school._id }, { text: '' });
    expect(bad).toMatchObject({ ok: false, executed: false });
    expect(bad.error).toMatch(/Invalid/);
    expect(await actions.run('delete.everything', {}, {})).toMatchObject({ ok: false, error: expect.stringContaining('Unknown action') });
  });
});

describe('provider failure', () => {
  test('when the model is unreachable a complaint still becomes a ticket through the rule-based path, with an honest reply', async () => {
    global.fetch.mockResolvedValue({ ok: false, status: 503, text: async () => 'down' });
    const res = await ask(A.parentUser, 'meri complaint hai, teacher se baat karni hai');
    expect(res.body.success).toBe(true);
    expect(res.body.data.replies[0].action).toBe('handoff');
    expect(await AssistantTicket.countDocuments({})).toBe(1);
    const entry = await require('../src/models/AssistantQuery').findOne({});
    expect(entry.trace.find((s) => s.step === 'understand')).toMatchObject({ fallback: true });
    expect(entry.actions[0]).toMatchObject({ name: 'ticket.create', ok: true, verified: true });
  });
});

describe('observability', () => {
  test('each request has an id and a trace of its steps and actions, without the message text', async () => {
    scriptedModel([part({ text: 'secret words here', kind: 'forward', subject: 'Maths', brief: BRIEF })]);
    const res = await ask(A.parentUser, 'secret words here');
    expect(res.body.data.requestId).toMatch(/^[0-9a-f-]{36}$/);
    const entry = await require('../src/models/AssistantQuery').findOne({});
    expect(entry.requestId).toBe(res.body.data.requestId);
    const names = entry.trace.map((s) => s.step);
    expect(names).toEqual(expect.arrayContaining(['understand', 'action:ticket.create', 'respond']));
    expect(JSON.stringify(entry.trace)).not.toContain('secret words');
  });
});
