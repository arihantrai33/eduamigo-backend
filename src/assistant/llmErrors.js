// What went wrong when a language model call failed, and what to tell the person.
//
// classify(err) gives a kind and whether trying again can help:
//   dns          the host name could not be resolved (ENOTFOUND, EAI_AGAIN)          retry
//   connect      could not connect (refused, unreachable, connect timeout)           retry
//   reset        the connection dropped before an answer                             retry
//   timeout      no answer within the time allowed                                   retry
//   rate_limit   HTTP 429                                                            retry once or twice, after the provider's wait
//   server       HTTP 500, 502, 503, 504                                             retry
//   empty        the provider answered with nothing                                  retry
//   tls          certificate or handshake problem                                    no retry (not transient)
//   auth         HTTP 401 or 403: the key is wrong or has no permission              no retry
//   config       HTTP 404 or a missing setting: wrong endpoint or deployment          no retry
//   bad_request  HTTP 400 or 422: the request itself was refused                     no retry
//   unknown      anything else                                                       no retry
//
// reasonOf(kinds) folds the kinds of all providers into what the student is told:
//   network | timeout | busy | config | failed

class AiError extends Error {
  constructor(message, { reason = 'failed', kinds = [], attempts = 1 } = {}) {
    super(message);
    this.name = 'AiError';
    this.reason = reason;
    this.kinds = kinds;
    this.attempts = attempts;
    this.retryable = ['network', 'timeout', 'busy'].includes(reason);
  }
}

const CODES = {
  dns: ['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL', 'EAI_NODATA', 'EAI_NONAME'],
  connect: ['ECONNREFUSED', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN', 'EADDRNOTAVAIL'],
  reset: ['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_CLOSED', 'UND_ERR_ABORTED', 'ECONNABORTED'],
};
const TLS = /^(CERT_|ERR_TLS_|UNABLE_TO_|DEPTH_ZERO|SELF_SIGNED|ERR_SSL|EPROTO)/;
const RETRYABLE = new Set(['dns', 'connect', 'reset', 'timeout', 'rate_limit', 'server', 'empty']);

// The code Node puts on a network failure: fetch wraps it as TypeError('fetch failed') with the real error in `cause`.
const codeOf = (err) => err?.cause?.code || err?.code || err?.cause?.cause?.code || '';

function classify(err) {
  const status = Number(err?.status) || Number(/\b(?:Azure OpenAI|HTTP|status)\s*(\d{3})\b/.exec(err?.message || '')?.[1]) || null;
  const code = String(codeOf(err));
  const msg = String(err?.message || '');
  let kind = 'unknown';
  if (status) {
    if (status === 401 || status === 403) kind = 'auth';
    else if (status === 404) kind = 'config';
    else if (status === 429) kind = 'rate_limit';
    else if (status === 400 || status === 422) kind = 'bad_request';
    else if (status >= 500) kind = 'server';
  } else if (CODES.dns.includes(code)) kind = 'dns';
  else if (TLS.test(code)) kind = 'tls';
  else if (CODES.connect.includes(code)) kind = 'connect';
  else if (CODES.reset.includes(code)) kind = 'reset';
  else if (err?.name === 'TimeoutError' || err?.name === 'AbortError' || code === 'ETIMEOUT' || /timed out|timeout|aborted/i.test(msg)) kind = 'timeout';
  else if (/not configured|no language model/i.test(msg)) kind = 'config';
  else if (/empty response/i.test(msg)) kind = 'empty';
  // The Gemini SDK reports "fetch failed" or "Request aborted" in its own words, without the Node code.
  else if (/fetch failed|network|socket hang up|other side closed|terminated/i.test(msg)) kind = 'connect';
  return { kind, code: code || null, status, retryable: RETRYABLE.has(kind) };
}

const NETWORK = new Set(['dns', 'connect', 'reset']);
function reasonOf(kinds) {
  const k = new Set(kinds);
  if ([...k].some((x) => NETWORK.has(x))) return 'network';
  if (k.has('timeout')) return 'timeout';
  if (k.has('rate_limit') || k.has('server')) return 'busy';
  if (k.has('auth') || k.has('config') || k.has('tls') || k.has('bad_request')) return 'config';
  return 'failed';
}

// Written for the student (the tutor and practice). `what` is the feature's name in the sentence.
const STUDENT_MESSAGES = {
  network: (what) => `${what} could not reach the AI service because of a temporary network problem on the server. It is not caused by your question and nothing was guessed. Please try again in a moment.`,
  timeout: (what) => `${what} took too long to get an answer from the AI service. Nothing was guessed. Please try again; a shorter question can help.`,
  busy: (what) => `The AI service is busy or temporarily unavailable, so ${what} could not answer. Nothing was guessed. Please try again in a minute.`,
  config: (what) => `${what} cannot answer because the AI service is not set up correctly on this server. Please tell your school's administrator.`,
  failed: (what) => `${what} could not answer just now. Nothing was guessed; please try again.`,
};
const studentMessage = (reason, what = 'The AI Tutor') => (STUDENT_MESSAGES[reason] || STUDENT_MESSAGES.failed)(what);

// Same message for the practice endpoints (a sentence about what could not be prepared).
const practiceMessage = (reason, doing) => ({
  network: `${doing} failed because of a temporary network problem reaching the AI service. Nothing was recorded. Please try again in a moment.`,
  timeout: `${doing} took too long. Nothing was recorded. Please try again.`,
  busy: `The AI service is busy or temporarily unavailable. ${doing} did not happen and nothing was recorded. Please try again in a minute.`,
  config: `${doing} is not possible because the AI service is not set up correctly on this server. Please tell your school's administrator.`,
  failed: null,
})[reason] || null;

// Delay before retry number `attempt` (0 for the first retry): 300 ms, 900 ms ... with a little jitter so many requests do not retry together.
const baseMs = () => Number(process.env.ASSISTANT_RETRY_BASE_MS || 300);
const backoffMs = (attempt) => Math.round(baseMs() * 3 ** attempt * (0.75 + Math.random() * 0.5));

// Text that is safe to put in a log: no API keys, bearer tokens or key= query values.
const redact = (text) => String(text || '')
  .replace(/(api[-_]?key|authorization|bearer|key)(["'\s:=]+)[A-Za-z0-9._~+/-]{8,}/gi, '$1$2[redacted]')
  .replace(/([?&](?:key|api-key|api_key)=)[^&\s"']+/gi, '$1[redacted]')
  .slice(0, 300);

const sleep = (ms, signal) => new Promise((resolve) => {
  if (signal?.aborted) return resolve();
  const t = setTimeout(resolve, ms);
  signal?.addEventListener?.('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});

module.exports = { AiError, classify, reasonOf, studentMessage, practiceMessage, backoffMs, redact, sleep };
