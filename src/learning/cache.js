// A small cache for generic tutor answers, so the same standard question is not paid for again and again.
//
// What may be cached (all of these must hold): a single question with no conversation before it; the school's notes were searched
// and none matched (so the answer is a general explanation, not built from school material); no calculation failed its check;
// the answer finished. Everything that depends on a person is excluded: follow-ups, answers that quote school notes, spoken
// replies with their own length limit, and anything with a failed check.
//
// Isolation: the key contains the school, the class, the language, the mode and the notes stamp (see materials.notesStamp), so a
// school only ever receives answers produced for its own class, and an answer is dropped as soon as the class's notes change.
// Nothing is stored that identifies a student: the tutor prompt holds no names. Entries expire after LEARNING_CACHE_HOURS (24).

const crypto = require('crypto');

const store = new Map();
const MAX = 500;
const ttl = () => Number(process.env.LEARNING_CACHE_HOURS || 24) * 3600 * 1000;

const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').replace(/[?!.,;:]+$/g, '').trim();

function keyFor({ schoolId, cls, language, mode, spoken, message, stamp }) {
  return crypto.createHash('sha256').update(JSON.stringify([String(schoolId), String(cls), language, mode, !!spoken, norm(message), stamp])).digest('hex');
}

// Whether this request may use the cache at all (before looking anything up).
const eligible = ({ historyLength, message }) => ttl() > 0 && historyLength === 0 && norm(message).length >= 3 && norm(message).length <= 200;

function get(key) {
  const hit = store.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > ttl()) { store.delete(key); return null; }
  return hit.value;
}

function set(key, value) {
  if (store.size >= MAX) store.delete(store.keys().next().value);
  store.set(key, { at: Date.now(), value });
}

const clear = () => store.clear();
const size = () => store.size;

module.exports = { keyFor, eligible, get, set, clear, size };
