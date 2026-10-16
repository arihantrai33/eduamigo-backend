// A natural spoken voice for the AI Tutor: neural text-to-speech from Gemini, so the answer is read in a fluent human voice
// (Hindi and English) instead of the robotic voices installed on a student's device. It reads text the screen already shows;
// the browser still falls back to its own voice when this is off or fails.
//
//   ASSISTANT_TTS=off          switches the spoken voice off (the tutor then uses the device's own voice)
//   ASSISTANT_TTS_MODEL        models to try in order, default "gemini-3.8-flash-tts,gemini-3.8-flash-lite-tts" (clear Hindi
//                              and English; ~3 s for a sentence). When one is out of quota or failing, the next is used, and
//                              the first is left alone for a while.
//   ASSISTANT_TTS_VOICE        default Achird (a friendly voice)
//   ASSISTANT_TTS_TIMEOUT_MS   default 20000
//   GEMINI_API_KEY             the same key the tutor already uses as a fallback provider
//
// Azure AI Speech is tried first when AZURE_SPEECH_KEY and AZURE_SPEECH_REGION are set: neural Indian voices (Hindi
// hi-IN-SwaraNeural, English en-IN-NeerjaNeural), a fraction of a second per sentence, steady pronunciation and natural pauses
// at punctuation, with no daily request quota like Gemini's free tier. Gemini is the fallback.
//   ASSISTANT_TTS_VOICE_HI / ASSISTANT_TTS_VOICE_EN   Azure voice names (the script of the text picks the language)
//   ASSISTANT_TTS_RATE         speaking speed for Azure, default +4%
//
// Nothing is added to the text: the model speaks everything it is given (an instruction such as "say warmly:" is read out
// aloud), so the text is sent as it is. Every call is recorded in the AI usage ledger (feature voice_out) and is subject to
// the school's monthly budget and token limits, like every other paid AI call.

const crypto = require('crypto');
const aiUsage = require('../services/aiUsage');
const { HttpError } = require('../utils/http');

const MAX_CHARS = 600;
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 150;
const cache = new Map(); // key -> { at, audio, mime }

const models = () => String(process.env.ASSISTANT_TTS_MODEL || 'gemini-3.8-flash-tts,gemini-3.8-flash-lite-tts').split(',').map((m) => m.trim()).filter(Boolean);
const SKIP_MS = 10 * 60 * 1000;
const skipUntil = new Map(); // model -> time before which it is not tried (it was out of quota or failing)
const voiceName = () => process.env.ASSISTANT_TTS_VOICE || 'Achird';
const timeoutMs = () => Number(process.env.ASSISTANT_TTS_TIMEOUT_MS || 20000);
const off = (name) => String(process.env[name] || '').toLowerCase() === 'off';

// True when a spoken answer can be produced right now.
const azureReady = () => !!process.env.AZURE_SPEECH_KEY && !!process.env.AZURE_SPEECH_REGION;
const available = () => !off('ASSISTANT_TTS') && !off('ASSISTANT_AI') && (azureReady() || !!process.env.GEMINI_API_KEY);

// Raw 16-bit mono PCM -> a WAV file the browser can play.
function wrapPcm(pcm, rate = 24000) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

const unavailable = (why) => Object.assign(new HttpError(503, 'The natural voice is not available right now.', { code: 'VOICE_UNAVAILABLE', why }), { expose: true });

// One call to one model: { audio } or throws an Error with .status (the provider's HTTP status, 0 for a network error or timeout).
async function callModel(m, voice, clean, apiKey) {
  const started = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs());
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [{ parts: [{ text: clean }] }],
        generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
      }),
      signal: ctl.signal,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status} ${String(body?.error?.message || '').split('\n')[0].replace(apiKey, '<key>').slice(0, 100)}`), { status: res.status });
    const part = body?.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
    if (!part) throw Object.assign(new Error('no audio in the reply'), { status: 502 });
    const raw = Buffer.from(part.inlineData.data, 'base64');
    const mime = String(part.inlineData.mimeType || '');
    const isWav = raw.length > 12 && raw.slice(0, 4).toString() === 'RIFF';
    const rate = Number((/rate=(\d+)/.exec(mime) || [])[1] || 24000);
    aiUsage.record({
      feature: 'voice_out', provider: 'gemini', model: m, voice: true, ms: Date.now() - started,
      inputTokens: body.usageMetadata?.promptTokenCount, outputTokens: body.usageMetadata?.candidatesTokenCount,
      estimated: body.usageMetadata?.candidatesTokenCount == null,
    });
    return isWav ? raw : wrapPcm(raw, rate);
  } catch (err) {
    aiUsage.record({ feature: 'voice_out', provider: 'gemini', model: m, voice: true, ok: false, ms: Date.now() - started, estimated: true });
    throw Object.assign(err, { status: err.status ?? (err.name === 'AbortError' ? 0 : 0), timedOut: err.name === 'AbortError' });
  } finally {
    clearTimeout(timer);
  }
}

const xml = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

// One call to Azure AI Speech: { audio } (WAV) or throws an Error with .status.
async function callAzure(clean) {
  const started = Date.now();
  const hindi = /[\u0900-\u097F]/.test(clean);
  const voice = hindi ? (process.env.ASSISTANT_TTS_VOICE_HI || 'hi-IN-SwaraNeural') : (process.env.ASSISTANT_TTS_VOICE_EN || 'en-IN-NeerjaNeural');
  const ssml = `<speak version="1.0" xml:lang="${hindi ? 'hi-IN' : 'en-IN'}"><voice name="${xml(voice)}"><prosody rate="${xml(process.env.ASSISTANT_TTS_RATE || '+4%')}">${xml(clean)}</prosody></voice></speak>`;
  const key = process.env.AZURE_SPEECH_KEY;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs());
  try {
    const res = await fetch(`https://${process.env.AZURE_SPEECH_REGION}.tts.speech.microsoft.com/cognitiveservices/v1`, {
      method: 'POST',
      headers: { 'Ocp-Apim-Subscription-Key': key, 'Content-Type': 'application/ssml+xml', 'X-Microsoft-OutputFormat': 'riff-24khz-16bit-mono-pcm', 'User-Agent': 'EduAmigo' },
      body: ssml,
      signal: ctl.signal,
    });
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
    const audio = Buffer.from(await res.arrayBuffer());
    if (audio.length < 100) throw Object.assign(new Error('no audio in the reply'), { status: 502 });
    aiUsage.record({ feature: 'voice_out', provider: 'azure', model: voice, voice: true, ms: Date.now() - started, inputTokens: Math.ceil(clean.length / 4), estimated: true });
    return audio;
  } catch (err) {
    aiUsage.record({ feature: 'voice_out', provider: 'azure', model: voice, voice: true, ok: false, ms: Date.now() - started, estimated: true });
    throw Object.assign(err, { status: err.status ?? 0, timedOut: err.name === 'AbortError' });
  } finally {
    clearTimeout(timer);
  }
}

// One piece of text -> { audio: Buffer, mime, cached }. Tries the configured models in order; throws a 503 (VOICE_UNAVAILABLE)
// when all of them fail, and the app then speaks with the device's own voice.
async function synthesize({ text }) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!available()) throw unavailable('off');
  const v = voiceName();
  const apiKey = process.env.GEMINI_API_KEY || '';
  const list = apiKey ? models() : [];
  const key = crypto.createHash('sha256').update(JSON.stringify([v, clean])).digest('hex');
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    aiUsage.record({ feature: 'voice_out', cached: true, voice: true });
    return { audio: hit.audio, mime: hit.mime, cached: true };
  }
  const ids = [...(azureReady() ? ['azure'] : []), ...list];
  const tried = ids.filter((m) => (skipUntil.get(m) || 0) <= Date.now());
  const errors = [];
  for (const m of tried.length ? tried : ids.slice(-1)) {
    try {
      const audio = m === 'azure' ? await callAzure(clean) : await callModel(m, v, clean, apiKey);
      if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
      cache.set(key, { at: Date.now(), audio, mime: 'audio/wav' });
      return { audio, mime: 'audio/wav', cached: false, model: m };
    } catch (err) {
      errors.push(`${m}: ${err.timedOut ? 'timeout' : err.message}`);
      // Out of quota (429), a server error or a timeout: leave this model alone for a while and try the next.
      if (err.status === 429 || err.status >= 500 || err.status === 0) skipUntil.set(m, Date.now() + SKIP_MS);
    }
  }
  throw unavailable((apiKey ? errors.join('; ').replace(apiKey, '<key>') : errors.join('; ')).slice(0, 240));
}

const resetForTests = () => { cache.clear(); skipUntil.clear(); };

module.exports = { available, synthesize, wrapPcm, resetForTests, MAX_CHARS };
