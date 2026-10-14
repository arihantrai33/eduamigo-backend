// Network and provider failures: what kind of failure it was, which ones are tried again (and how often, and for how long), and
// what the student is told. Every provider call is mocked (global.fetch); nothing here is paid for and no network is used.

const { api, connect, disconnect, clear, auth, seedSchool } = require('./helpers');
const AiUsage = require('../src/models/AiUsage');
const PracticeSession = require('../src/models/PracticeSession');
const AssistantTicket = require('../src/models/AssistantTicket');
const llm = require('../src/assistant/llm');
const aiUsage = require('../src/services/aiUsage');
const { classify, reasonOf, redact, studentMessage, AiError } = require('../src/assistant/llmErrors');

const ENV = { ...process.env };
const enc = new TextEncoder();
let A;
let fetchCalls;

// The error Node's fetch throws for a network failure: TypeError('fetch failed') with the real code in `cause`.
const netErr = (code) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(`getaddrinfo ${code}`), { code }) });
const sseBody = (pieces, { failAfter = null } = {}) => ({
  ok: true,
  body: (async function* body() {
    for (const p of pieces) yield enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`);
    if (failAfter) throw netErr(failAfter);
    yield enc.encode('data: [DONE]\n\n');
  }()),
});
const jsonOk = (content) => ({ ok: true, json: async () => ({ choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }) });
const http = (status, retryAfter = null) => ({ ok: false, status, text: async () => 'provider said no', headers: { get: (h) => (String(h).toLowerCase() === 'retry-after' ? retryAfter : null) } });

// fetch plays a script, one entry per call: a response, or a function (opts) => response | Promise, or an Error to reject with.
const script = (...steps) => {
  let i = 0;
  global.fetch = jest.fn(async (url, opts) => {
    fetchCalls = global.fetch.mock.calls.length;
    const step = steps[Math.min(i, steps.length - 1)];
    i += 1;
    if (step instanceof Error) throw step;
    return typeof step === 'function' ? step(opts) : step;
  });
};
const drain = async (out) => { let t = ''; for await (const p of out.pieces) t += p; return t; };
const inSchool = (feature, fn) => aiUsage.within({ school: A.school._id, user: A.studentUser._id, feature }, fn);
const stream = (extra = {}) => inSchool('tutor', () => llm.stream({ messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'q' }], maxTokens: 50, feature: 'tutor', ...extra }));
const failure = async (fn) => { try { await fn(); } catch (err) { return err; } throw new Error('expected a failure'); };

const parse = (res) => JSON.parse(`[${String(res.body).trim().split('\n').filter(Boolean).join(',')}]`);
const chat = (user, body) => api().post('/api/learning/chat').set(auth(user)).send(body).buffer(true).parse((res, cb) => { let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => cb(null, t)); });
const errorEvent = async (body = { message: 'What is a fraction?' }) => parse(await chat(A.studentUser, body)).find((e) => e.type === 'error');

beforeAll(connect);
afterAll(async () => { process.env = ENV; await disconnect(); });
beforeEach(async () => {
  await clear();
  A = await seedSchool('Alpha School');
  process.env = { ...ENV, ASSISTANT_AI: 'on', ASSISTANT_PROVIDERS: 'azure', AZURE_OPENAI_ENDPOINT: 'https://example.openai.azure.com', AZURE_OPENAI_API_KEY: 'sk-test-not-a-real-key-123', AZURE_OPENAI_DEPLOYMENT: 'gpt-test', GEMINI_API_KEY: '', LEARNING_VECTOR_SEARCH: 'off', ASSISTANT_RETRY_BASE_MS: '1' };
  llm.resetForTests();
  aiUsage.resetForTests();
});

describe('classifying a failure', () => {
  const kind = (err) => classify(err).kind;
  test.each([
    ['EAI_AGAIN', 'dns'], ['ENOTFOUND', 'dns'],
    ['ECONNREFUSED', 'connect'], ['ETIMEDOUT', 'connect'], ['UND_ERR_CONNECT_TIMEOUT', 'connect'], ['ENETUNREACH', 'connect'],
    ['ECONNRESET', 'reset'], ['UND_ERR_SOCKET', 'reset'],
    ['CERT_HAS_EXPIRED', 'tls'], ['ERR_TLS_CERT_ALTNAME_INVALID', 'tls'],
  ])('a network error with code %s is %s', (code, expected) => {
    expect(kind(netErr(code))).toBe(expected);
  });

  test('which kinds are worth trying again', () => {
    for (const k of [netErr('EAI_AGAIN'), netErr('ECONNRESET'), netErr('ECONNREFUSED'), Object.assign(new Error('x'), { status: 503 }), Object.assign(new Error('x'), { status: 429 }), new DOMException('slow', 'TimeoutError')]) {
      expect(classify(k).retryable).toBe(true);
    }
    for (const k of [netErr('CERT_HAS_EXPIRED'), Object.assign(new Error('x'), { status: 401 }), Object.assign(new Error('x'), { status: 403 }), Object.assign(new Error('x'), { status: 404 }), Object.assign(new Error('x'), { status: 400 }), Object.assign(new Error('x'), { status: 422 }), new Error('something odd')]) {
      expect(classify(k).retryable).toBe(false);
    }
  });

  test('HTTP statuses: wrong key, wrong deployment, rate limit, refused request, provider error', () => {
    const s = (status) => kind(Object.assign(new Error('Azure OpenAI'), { status }));
    expect([s(401), s(403), s(404), s(429), s(400), s(422), s(500), s(502), s(503), s(504)]).toEqual(['auth', 'auth', 'config', 'rate_limit', 'bad_request', 'bad_request', 'server', 'server', 'server', 'server']);
    expect(kind(new Error('Azure OpenAI 401: Access denied'))).toBe('auth'); // status read from the message when it is not on the error
  });

  test('timeouts, and the Gemini library\'s own wording', () => {
    expect(kind(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))).toBe('timeout');
    expect(kind(Object.assign(new Error('timed out after 10000 ms'), { code: 'ETIMEOUT' }))).toBe('timeout');
    expect(kind(new Error('[GoogleGenerativeAI Error]: Error fetching from https://example.test/x: fetch failed'))).toBe('connect');
    expect(kind(new Error('[GoogleGenerativeAI Error]: Request aborted when fetching https://example.test/x'))).toBe('timeout');
    expect(kind(new Error('empty response'))).toBe('empty');
  });

  test('what the student is told depends on the kinds that failed, network first', () => {
    expect(reasonOf(['dns'])).toBe('network');
    expect(reasonOf(['connect', 'timeout'])).toBe('network');
    expect(reasonOf(['timeout'])).toBe('timeout');
    expect(reasonOf(['rate_limit'])).toBe('busy');
    expect(reasonOf(['server', 'auth'])).toBe('busy');
    expect(reasonOf(['auth'])).toBe('config');
    expect(reasonOf(['config'])).toBe('config');
    expect(reasonOf(['unknown'])).toBe('failed');
    expect(new AiError('x', { reason: 'network' }).retryable).toBe(true);
    expect(new AiError('x', { reason: 'config' }).retryable).toBe(false);
  });

  test('messages say whether to try again, never mention keys or settings names', () => {
    expect(studentMessage('network')).toMatch(/temporary network problem.*not caused by your question.*try again/s);
    expect(studentMessage('timeout')).toMatch(/took too long/);
    expect(studentMessage('busy')).toMatch(/busy or temporarily unavailable/);
    expect(studentMessage('config')).toMatch(/not set up correctly.*administrator/);
    expect(studentMessage('config')).not.toMatch(/try again/i);
    for (const r of ['network', 'timeout', 'busy', 'config', 'failed']) expect(studentMessage(r)).not.toMatch(/AZURE|ASSISTANT_|api[-_ ]?key|\.env/i);
  });

  test('logged text has keys and bearer tokens removed', () => {
    expect(redact('request failed with api-key: sk-abcdef1234567890 for host')).not.toContain('sk-abcdef1234567890');
    expect(redact('GET /v1/models/x?alt=sse&key=AIzaSyA1234567890abcdef failed')).not.toContain('AIzaSyA1234567890abcdef');
    expect(redact('Authorization: Bearer abcdefghijklmnop1234')).not.toContain('abcdefghijklmnop1234');
  });
});

describe('retrying a streamed answer', () => {
  test('a DNS failure twice and then success: the student never notices', async () => {
    script(netErr('EAI_AGAIN'), netErr('EAI_AGAIN'), sseBody(['Hello ', 'there.']));
    const out = await stream();
    expect(await inSchool('tutor', () => drain(out))).toBe('Hello there.'); // the ledger row is written when the stream ends, inside the request's context
    expect(out.provider).toBe('azure');
    expect(fetchCalls).toBe(3);
    await aiUsage.flush();
    expect(await AiUsage.countDocuments({ feature: 'tutor', ok: { $ne: false } })).toBe(1); // one answered call, not three
  });

  test('the number of tries is bounded: 1 + ASSISTANT_RETRIES, then a "network" failure', async () => {
    script(netErr('EAI_AGAIN'));
    const err = await failure(() => stream());
    expect(fetchCalls).toBe(3);
    expect(err).toBeInstanceOf(AiError);
    expect(err).toMatchObject({ reason: 'network', retryable: true, kinds: ['dns'] });
    process.env.ASSISTANT_RETRIES = '0';
    script(netErr('ECONNRESET'));
    await failure(() => stream());
    expect(fetchCalls).toBe(1);
    process.env.ASSISTANT_RETRIES = '5';
    script(netErr('ECONNRESET'));
    await failure(() => stream());
    expect(fetchCalls).toBe(6);
  });

  test('a wrong key, a wrong deployment and a refused request are not retried', async () => {
    for (const [status, reason] of [[401, 'config'], [403, 'config'], [404, 'config'], [400, 'config']]) {
      llm.resetForTests();
      script(http(status));
      const err = await failure(() => stream());
      expect(fetchCalls).toBe(1);
      expect(err).toMatchObject({ reason, retryable: false });
    }
  });

  test('a provider error (503) and a rate limit (429) are tried again, and then reported as busy', async () => {
    script(http(503), sseBody(['ok.']));
    expect(await drain(await stream())).toBe('ok.');
    expect(fetchCalls).toBe(2);
    script(http(429, '0'), sseBody(['ok again.']));
    expect(await drain(await stream())).toBe('ok again.');
    expect(fetchCalls).toBe(2);
    script(http(503));
    const err = await failure(() => stream());
    expect(fetchCalls).toBe(3);
    expect(err).toMatchObject({ reason: 'busy', retryable: true });
  });

  test('the overall time budget stops the retries early', async () => {
    process.env.ASSISTANT_RETRY_BASE_MS = '200';
    process.env.ASSISTANT_RETRY_BUDGET_MS = '100';
    script(netErr('EAI_AGAIN'));
    const t = Date.now();
    await failure(() => stream());
    expect(fetchCalls).toBe(1); // the first wait (about 200 ms) would not fit in 100 ms
    expect(Date.now() - t).toBeLessThan(400);
  });

  test('a connection that never answers is cut off by the timeout, tried again, and reported as a timeout', async () => {
    process.env.ASSISTANT_TIMEOUT_MS = '60';
    const hang = (opts) => new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(opts.signal.reason || new Error('aborted'))));
    script(hang);
    const t = Date.now();
    const err = await failure(() => stream());
    expect(fetchCalls).toBe(3);
    expect(err).toMatchObject({ reason: 'timeout', kinds: ['timeout'], retryable: true });
    expect(Date.now() - t).toBeLessThan(1500);
  });

  test('a failed try is aborted, not left running', async () => {
    process.env.ASSISTANT_TIMEOUT_MS = '60';
    process.env.ASSISTANT_RETRIES = '0';
    let signal;
    script((opts) => { signal = opts.signal; return new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(new Error('aborted')))); });
    await failure(() => stream());
    expect(signal.aborted).toBe(true);
  });

  test('a failure after the first piece is not retried: the answer already started', async () => {
    script(sseBody(['The first sentence. '], { failAfter: 'ECONNRESET' }));
    const out = await stream();
    const err = await failure(() => drain(out));
    expect(err.cause?.code || err.code).toBe('ECONNRESET');
    expect(fetchCalls).toBe(1);
  });

  test('a cancelled request is not retried', async () => {
    const ctl = new AbortController();
    script((opts) => { ctl.abort(); throw netErr('ECONNRESET'); });
    await failure(() => stream({ signal: ctl.signal }));
    expect(fetchCalls).toBe(1);
  });

  test('network failures do not put the provider in its one-minute cooling off; its own errors do', async () => {
    script(netErr('EAI_AGAIN'));
    for (let i = 0; i < 4; i += 1) await failure(() => stream());
    expect(fetchCalls).toBe(12); // 4 questions x 3 tries: Azure was never skipped
    expect(llm.status().providers.find((p) => p.name === 'azure').coolingOff).toBe(false);
    process.env.ASSISTANT_RETRIES = '0';
    script(http(500));
    for (let i = 0; i < 3; i += 1) await failure(() => stream());
    expect(llm.status().providers.find((p) => p.name === 'azure').coolingOff).toBe(true);
  });
});

describe('retrying a one-shot call (Ask, practice)', () => {
  const call = () => inSchool('practice', () => llm.complete({ system: 's', user: 'q', maxTokens: 20, cache: false, feature: 'practice' }));

  test('transient failures are retried and the answer is returned once', async () => {
    script(netErr('EAI_AGAIN'), http(502), jsonOk('fine'));
    const out = await call();
    expect(out.text).toBe('fine');
    expect(fetchCalls).toBe(3);
    await aiUsage.flush();
    expect(await AiUsage.countDocuments({ ok: { $ne: false } })).toBe(1); // one answered call, not three
  });

  test('wrong key: one call, no retry, reason config', async () => {
    script(http(401));
    const err = await failure(call);
    expect(fetchCalls).toBe(1);
    expect(err).toMatchObject({ reason: 'config', retryable: false });
  });

  test('persistent network failure: bounded tries, then a "network" failure that is recorded as a failed call with no tokens', async () => {
    script(netErr('ECONNREFUSED'));
    const err = await failure(call);
    expect(fetchCalls).toBe(3);
    expect(err.reason).toBe('network');
    await aiUsage.flush();
    const failed = await AiUsage.find({ ok: false }).lean();
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ inputTokens: 0, outputTokens: 0, feature: 'practice' });
  });
});

describe('what the student sees', () => {
  test('a temporary network problem: a retryable error that says so', async () => {
    script(netErr('EAI_AGAIN'));
    const ev = await errorEvent();
    expect(ev).toMatchObject({ code: 'AI_FAILED', reason: 'network', retryable: true });
    expect(ev.message).toMatch(/temporary network problem/);
    expect(await AssistantTicket.countDocuments({})).toBe(0);
  });

  test('a busy provider is a different message from a network failure', async () => {
    script(http(503));
    const ev = await errorEvent();
    expect(ev).toMatchObject({ reason: 'busy', retryable: true });
    expect(ev.message).toMatch(/busy or temporarily unavailable/);
    expect(ev.message).not.toMatch(/network/);
  });

  test('a wrong key is not offered as something to retry, and the message never shows the key or its name', async () => {
    script(http(401));
    const ev = await errorEvent();
    expect(ev).toMatchObject({ reason: 'config', retryable: false });
    expect(ev.message).toMatch(/not set up correctly/);
    expect(JSON.stringify(ev)).not.toMatch(/sk-test-not-a-real-key|AZURE_OPENAI/);
  });

  test('a timeout says it took too long', async () => {
    process.env.ASSISTANT_TIMEOUT_MS = '60';
    script((opts) => new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(new Error('aborted')))));
    const ev = await errorEvent();
    expect(ev).toMatchObject({ reason: 'timeout', retryable: true });
    expect(ev.message).toMatch(/took too long/);
  });

  test('the AI being switched off or unconfigured is still its own message (not a network problem)', async () => {
    process.env.ASSISTANT_AI = 'off';
    const ev = await errorEvent();
    expect(ev).toMatchObject({ code: 'AI_UNAVAILABLE', reason: 'off' });
  });

  test('practice: a network failure saves nothing and the response carries the reason', async () => {
    script(netErr('EAI_AGAIN'));
    const res = await api().post('/api/learning/practice').set(auth(A.studentUser)).send({ subject: 'Mathematics', topic: 'Fractions' });
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ code: 'AI_FAILED', reason: 'network', retryable: true });
    expect(res.body.message).toMatch(/temporary network problem.*Nothing was recorded/s);
    expect(await PracticeSession.countDocuments({})).toBe(0);
  });

  test('practice with a wrong key says it is a setup problem', async () => {
    script(http(403));
    const res = await api().post('/api/learning/practice').set(auth(A.studentUser)).send({ subject: 'Mathematics', topic: 'Fractions' });
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ reason: 'config', retryable: false });
    expect(res.body.message).toMatch(/not set up correctly/);
  });
});
