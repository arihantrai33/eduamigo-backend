// The natural spoken voice of the AI Tutor (POST /api/learning/speak). No provider is contacted: global.fetch answers the
// text-to-speech request.

const { api, connect, disconnect, clear, auth, seedSchool } = require('./helpers');
const School = require('../src/models/School');
const AiUsage = require('../src/models/AiUsage');
const aiUsage = require('../src/services/aiUsage');
const speech = require('../src/learning/speech');

let A;
let sent;
const ENV = { ...process.env };

// A short, valid 16-bit mono WAV (what the provider sends back), and the same samples as raw PCM.
const pcm = Buffer.alloc(4800, 1);
const wav = speech.wrapPcm(pcm, 24000);
const ok = (inline) => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ inlineData: inline }] } }], usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 80 } }) });

beforeAll(connect);
afterAll(async () => { process.env = ENV; await disconnect(); });
beforeEach(async () => {
  await clear();
  A = await seedSchool('Alpha School');
  process.env = { ...ENV, GEMINI_API_KEY: 'test-key-123', ASSISTANT_AI: 'on' };
  delete process.env.ASSISTANT_TTS;
  delete process.env.AZURE_SPEECH_KEY;
  delete process.env.AZURE_SPEECH_REGION;
  speech.resetForTests();
  sent = [];
  global.fetch = jest.fn(async (url, opts) => { sent.push({ url, opts, body: JSON.parse(opts.body) }); return ok({ mimeType: 'audio/wav', data: wav.toString('base64') }); });
});

const speak = (user, body) => api().post('/api/learning/speak').set(auth(user)).send(body).buffer(true).parse((res, cb) => { const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))); });
const context = (user) => api().get('/api/learning/context').set(auth(user));
const rows = async (extra = {}) => { await aiUsage.flush(); return AiUsage.find({ school: A.school._id, feature: 'voice_out', ...extra }).lean(); };

describe('what the app is told', () => {
  test('the context says the natural voice is on only when it can work', async () => {
    expect((await context(A.studentUser)).body.data.capabilities.voice).toEqual({ natural: true });
    process.env.ASSISTANT_TTS = 'off';
    expect((await context(A.studentUser)).body.data.capabilities.voice).toEqual({ natural: false });
    process.env.ASSISTANT_TTS = 'on';
    delete process.env.GEMINI_API_KEY;
    expect((await context(A.studentUser)).body.data.capabilities.voice).toEqual({ natural: false });
    process.env.GEMINI_API_KEY = 'k';
    process.env.ASSISTANT_AI = 'off';
    expect((await context(A.studentUser)).body.data.capabilities.voice).toEqual({ natural: false });
  });
});

describe('speaking one piece of an answer', () => {
  test('returns audio, sends exactly the text with the key in a header (not the address) and no spoken instruction', async () => {
    const text = 'Photosynthesis is how plants make their own food from sunlight.';
    const res = await speak(A.studentUser, { text });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/audio\/wav/);
    expect(res.body.slice(0, 4).toString()).toBe('RIFF');
    expect(res.body.length).toBe(wav.length);
    expect(sent).toHaveLength(1);
    // The model reads out everything it is given: the text goes alone, never with a "say it warmly" instruction.
    expect(sent[0].body.contents[0].parts).toEqual([{ text }]);
    expect(sent[0].body.generationConfig.responseModalities).toEqual(['AUDIO']);
    expect(sent[0].url).not.toMatch(/test-key-123/);
    expect(sent[0].opts.headers['x-goog-api-key']).toBe('test-key-123');
  });

  test('raw PCM from the provider is wrapped as a playable WAV', async () => {
    global.fetch = jest.fn(async () => ok({ mimeType: 'audio/L16;codec=pcm;rate=24000', data: pcm.toString('base64') }));
    const res = await speak(A.studentUser, { text: 'Hello there.' });
    expect(res.status).toBe(200);
    expect(res.body.slice(0, 4).toString()).toBe('RIFF');
    expect(res.body.length).toBe(44 + pcm.length);
    expect(res.body.readUInt32LE(24)).toBe(24000);
  });

  test('the same piece asked again is answered from the cache (no second provider call) and still counted', async () => {
    await speak(A.studentUser, { text: 'One more time.' });
    const again = await speak(A.studentUser, { text: 'One more time.' });
    expect(again.headers['x-voice-cached']).toBe('1');
    expect(sent).toHaveLength(1);
    const all = await rows();
    expect(all.filter((r) => !r.cached)).toHaveLength(1);
    expect(all.filter((r) => r.cached)).toHaveLength(1);
  });

  test('every call is written to the AI usage ledger for the school, with the provider\'s tokens', async () => {
    await speak(A.studentUser, { text: 'Count this.' });
    const [row] = await rows({ cached: false });
    expect(row).toMatchObject({ feature: 'voice_out', provider: 'gemini', voice: true, inputTokens: 12, outputTokens: 80, ok: true });
    expect(String(row.school)).toBe(String(A.school._id));
    expect(String(row.user)).toBe(String(A.studentUser._id));
  });
});

describe('several models', () => {
  const quota = { ok: false, status: 429, json: async () => ({ error: { message: 'You exceeded your current quota' } }) };

  test('a model that is out of quota is skipped: the next one speaks, and the first is not tried again for a while', async () => {
    global.fetch = jest.fn(async (url, opts) => {
      sent.push({ url, opts, body: JSON.parse(opts.body) });
      return /flash-tts:/.test(url) ? quota : ok({ mimeType: 'audio/wav', data: wav.toString('base64') });
    });
    const first = await speak(A.studentUser, { text: 'First piece.' });
    expect(first.status).toBe(200);
    expect(first.body.slice(0, 4).toString()).toBe('RIFF');
    expect(sent.map((c) => c.url.match(/models\/([^:]+):/)[1])).toEqual(['gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts']);
    sent.length = 0;
    const second = await speak(A.studentUser, { text: 'Second piece.' });
    expect(second.status).toBe(200);
    // The first model is left alone now: one call, to the second.
    expect(sent.map((c) => c.url.match(/models\/([^:]+):/)[1])).toEqual(['gemini-3.8-flash-lite-tts']);
    // The failed attempt is in the ledger as a failure; the good ones as successes.
    const all = await rows({ cached: false });
    expect(all.filter((r) => !r.ok)).toHaveLength(1);
    expect(all.filter((r) => r.ok).map((r) => r.model)).toEqual(['gemini-3.8-flash-lite-tts', 'gemini-3.8-flash-lite-tts']);
  });

  test('when every model is out of quota the answer is a 503 for the app to fall back from', async () => {
    global.fetch = jest.fn(async () => quota);
    const res = await api().post('/api/learning/speak').set(auth(A.studentUser)).send({ text: 'Nobody can say this.' });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('VOICE_UNAVAILABLE');
  });

  test('the models to use can be set', async () => {
    process.env.ASSISTANT_TTS_MODEL = 'my-voice-model';
    await speak(A.studentUser, { text: 'Custom.' });
    expect(sent[0].url).toMatch(/models\/my-voice-model:/);
  });
});

describe('when it cannot speak', () => {
  test('a provider failure is a 503 the app can fall back from, and the key never reaches the message', async () => {
    global.fetch = jest.fn(async () => ({ ok: false, status: 500, json: async () => ({ error: { message: 'boom test-key-123' } }) }));
    const res = await api().post('/api/learning/speak').set(auth(A.studentUser)).send({ text: 'Say this.' });
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ success: false, code: 'VOICE_UNAVAILABLE' });
    expect(JSON.stringify(res.body)).not.toMatch(/test-key-123/);
    const [row] = await rows();
    expect(row).toMatchObject({ ok: false });
  });

  test('switched off: 503 VOICE_OFF and no provider call', async () => {
    process.env.ASSISTANT_TTS = 'off';
    const res = await api().post('/api/learning/speak').set(auth(A.studentUser)).send({ text: 'Say this.' });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('VOICE_OFF');
    expect(sent).toHaveLength(0);
  });

  test('a school at its monthly AI limit gets 429 and nothing is sent to the provider', async () => {
    await speak(A.studentUser, { text: 'First piece.' }); // 92 tokens used
    await School.updateOne({ _id: A.school._id }, { $set: { 'subscription.limits.aiTokensPerMonth': 50 } });
    sent.length = 0;
    const res = await api().post('/api/learning/speak').set(auth(A.studentUser)).send({ text: 'A different piece.' });
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ code: 'AI_LIMIT', limit: 'tokens' });
    expect(sent).toHaveLength(0);
  });
});

describe('who may ask, and what', () => {
  test('empty text and text longer than 600 characters are refused before anything is sent', async () => {
    expect((await api().post('/api/learning/speak').set(auth(A.studentUser)).send({ text: '   ' })).status).toBe(400);
    expect((await api().post('/api/learning/speak').set(auth(A.studentUser)).send({})).status).toBe(400);
    const long = await api().post('/api/learning/speak').set(auth(A.studentUser)).send({ text: 'a'.repeat(601) });
    expect(long.status).toBe(400);
    expect(sent).toHaveLength(0);
  });

  test('only students (signed in) can use it', async () => {
    expect((await api().post('/api/learning/speak').send({ text: 'Hi' })).status).toBe(401);
    for (const u of [A.parentUser, A.teacherUser, A.admin]) expect((await api().post('/api/learning/speak').set(auth(u)).send({ text: 'Hi' })).status).toBe(403);
    expect(sent).toHaveLength(0);
  });
});

describe('Azure AI Speech first, Gemini as the fallback', () => {
  const azureOk = () => ({ ok: true, status: 200, arrayBuffer: async () => wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.length) });
  beforeEach(() => { process.env.AZURE_SPEECH_KEY = 'az-key-999'; process.env.AZURE_SPEECH_REGION = 'centralindia'; });

  test('English text uses the Indian English voice, Hindi text the Hindi voice, as SSML with the key in a header', async () => {
    global.fetch = jest.fn(async (url, opts) => { sent.push({ url, opts }); return azureOk(); });
    expect((await speak(A.studentUser, { text: 'Water freezes at 0 degrees & melts again.' })).status).toBe(200);
    expect((await speak(A.studentUser, { text: 'पानी शून्य डिग्री पर जमता है।' })).status).toBe(200);
    expect(sent[0].url).toBe('https://centralindia.tts.speech.microsoft.com/cognitiveservices/v1');
    expect(sent[0].opts.headers['Ocp-Apim-Subscription-Key']).toBe('az-key-999');
    expect(sent[0].opts.body).toContain('en-IN-NeerjaNeural');
    expect(sent[0].opts.body).toContain('0 degrees &amp; melts'); // text is escaped, nothing is added to what is spoken
    expect(sent[1].opts.body).toContain('hi-IN-SwaraNeural');
    expect(JSON.stringify(sent)).not.toContain('generativelanguage');
  });

  test('works with only Azure configured, and the ledger names the provider', async () => {
    delete process.env.GEMINI_API_KEY;
    global.fetch = jest.fn(async () => azureOk());
    expect((await context(A.studentUser)).body.data.capabilities.voice).toEqual({ natural: true });
    expect((await speak(A.studentUser, { text: 'Hello there, class.' })).status).toBe(200);
    expect((await rows({ provider: 'azure' })).length).toBe(1);
  });

  test('when Azure fails the answer is spoken by Gemini, and Azure is left alone for a while', async () => {
    global.fetch = jest.fn(async (url, opts) => {
      sent.push({ url });
      if (String(url).includes('tts.speech.microsoft.com')) return { ok: false, status: 429 };
      return ok({ mimeType: 'audio/wav', data: wav.toString('base64') });
    });
    expect((await speak(A.studentUser, { text: 'First sentence here.' })).status).toBe(200);
    expect((await speak(A.studentUser, { text: 'Second sentence here.' })).status).toBe(200);
    expect(sent.filter((x) => String(x.url).includes('microsoft')).length).toBe(1);
  });
});
