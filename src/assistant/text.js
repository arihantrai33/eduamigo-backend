// Text helpers for EduAmigo Ask: normalising, typo-tolerant phrase matching, language detection
// and removal of personal data before any text leaves the server.

// Lower case, Unicode-normalised, punctuation turned into spaces. Devanagari letters and marks are kept.
function normalize(text) {
  return String(text || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[’'`]/g, '')
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const tokenize = (text) => (normalize(text) ? normalize(text).split(' ') : []);

// Damerau-Levenshtein distance (optimal string alignment), stopping early past `max`.
function editDistance(a, b, max = 2) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j += 1) d[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    let rowMin = Infinity;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      rowMin = Math.min(rowMin, d[i][j]);
    }
    if (rowMin > max) return max + 1;
  }
  return d[a.length][b.length];
}

// Typos are only forgiven on longer Latin words, where a near miss is very unlikely to be another word.
function closeEnough(token, word) {
  if (token === word) return true;
  if (!/^[a-z]+$/.test(token) || !/^[a-z]+$/.test(word)) return false;
  if (word.length < 5 || token.length < 4) return false;
  return editDistance(token, word, 2) <= (word.length >= 8 ? 2 : 1);
}

// Finds every phrase from `entries` ([{ key, phrase, weight }]) in the text.
// Longer phrases win: once "staff leave" matches, its words no longer count for "leave".
// The same phrase listed under several keys counts for each of them.
// Exact matches beat typo matches. Returns [{ key, phrase, weight, exact, start, end }].
function matchPhrases(text, entries) {
  const tokens = tokenize(text);
  const prepared = entries.map((e) => ({ ...e, words: tokenize(e.phrase) })).filter((e) => e.words.length);
  const lengths = [...new Set(prepared.map((e) => e.words.length))].sort((a, b) => b - a);
  const used = new Array(tokens.length).fill(false);
  const hits = [];

  for (const len of lengths) {
    const group = prepared.filter((e) => e.words.length === len);
    const found = [];
    for (const exact of [true, false]) {
      for (let i = 0; i + len <= tokens.length; i += 1) {
        if (used.slice(i, i + len).some(Boolean)) continue;
        if (found.some((f) => f.start < i + len && i < f.end && (f.exact || !exact))) continue;
        const window = tokens.slice(i, i + len);
        for (const e of group) {
          const ok = exact ? window.every((t, k) => t === e.words[k]) : window.every((t, k) => closeEnough(t, e.words[k]));
          if (ok && !found.some((f) => f.key === e.key && f.start === i)) {
            found.push({ key: e.key, phrase: e.phrase, weight: exact ? e.weight : e.weight * 0.8, exact, start: i, end: i + len });
          }
        }
      }
    }
    found.forEach((f) => { for (let k = f.start; k < f.end; k += 1) used[k] = true; });
    hits.push(...found);
  }
  return hits;
}

// Is the phrase (or a close typo of it) in the text?
const hasPhrase = (text, phrases) => matchPhrases(text, phrases.map((p) => ({ key: 'x', phrase: p, weight: 1 }))).length > 0;

// Common Hindi words written in Roman script: two or more of them means the user writes Hinglish.
const HINGLISH_MARKERS = new Set([
  'hai', 'hain', 'kya', 'kitni', 'kitna', 'kitne', 'kab', 'kahan', 'kaha', 'mera', 'meri', 'mere', 'mujhe', 'aur', 'ki', 'ka', 'ke',
  'nahi', 'nhi', 'batao', 'bata', 'bataye', 'btao', 'kaise', 'kaun', 'kaunsa', 'kaunsi', 'kal', 'aaj', 'chahiye', 'chahie', 'wala', 'wali',
  'gaya', 'gayi', 'raha', 'rahi', 'rha', 'hua', 'hui', 'kar', 'karo', 'karo', 'abhi', 'mein', 'me', 'ko', 'se', 'tha', 'thi', 'uski', 'uska',
  'beta', 'beti', 'bachche', 'bacche', 'baki', 'baaki', 'hoga', 'hogi', 'sab', 'kuch', 'jaldi', 'dikhao', 'bhai', 'ji',
]);

// 'hi' (Devanagari Hindi), 'hinglish' (Hindi in Roman script) or 'en'.
function detectLanguage(text) {
  const raw = String(text || '');
  if (/[ऀ-ॿ]/.test(raw)) return 'hi';
  const tokens = tokenize(raw);
  const markers = tokens.filter((t) => HINGLISH_MARKERS.has(t)).length;
  if (markers >= 2 || (tokens.length <= 3 && markers >= 1)) return 'hinglish';
  return 'en';
}

// Removes contact details and ID numbers before text is sent to an AI model or stored in the query log.
function redact(text) {
  return String(text || '')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/\b\d{4}\s?\d{4}\s?\d{4}\b/g, '[id number]')
    .replace(/(?:\+?91[\s-]?)?(?<!\d)[6-9]\d{4}[\s-]?\d{5}(?!\d)/g, '[phone]');
}

module.exports = { normalize, tokenize, editDistance, closeEnough, matchPhrases, hasPhrase, detectLanguage, redact };
