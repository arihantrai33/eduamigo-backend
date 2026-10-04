// Details pulled out of a question: which day or period, which class, which child, which person.
// All dates are school calendar days (midnight UTC of the Indian date, like attendance records).

const { tokenize, normalize, closeEnough } = require('./text');
const { toDayKey } = require('../utils/dates');

const DAY = 86400000;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WEEKDAY_WORDS = {
  sunday: 0, ravivar: 0, itwar: 0, monday: 1, somvar: 1, tuesday: 2, mangalvar: 2, mangal: 2, wednesday: 3, budhvar: 3, budh: 3,
  thursday: 4, guruvar: 4, brihaspativar: 4, friday: 5, shukravar: 5, shukra: 5, saturday: 6, shanivar: 6, shani: 6,
  'रविवार': 0, 'सोमवार': 1, 'मंगलवार': 2, 'बुधवार': 3, 'गुरुवार': 4, 'शुक्रवार': 5, 'शनिवार': 6,
};

const has = (tokens, words) => tokens.some((t) => words.includes(t));
const hasSeq = (text, seq) => ` ${normalize(text)} `.includes(` ${seq} `);

// Which day the question is about.
//   direction 'past'   - "kal" means yesterday (attendance)
//   direction 'future' - "kal" means tomorrow (timetable, exams, events)
// Returns { day, label } for a single day, { from, to, label } for a range, or null when no time was mentioned.
function parseWhen(text, { direction = 'future', now = new Date() } = {}) {
  const t = tokenize(text);
  const today = toDayKey(now);
  const shift = (n) => new Date(today.getTime() + n * DAY);

  if (has(t, ['today', 'aaj', 'aj', 'आज'])) return { day: today, label: 'today' };
  if (has(t, ['yesterday', 'बीता']) || hasSeq(text, 'beeta kal') || hasSeq(text, 'pichhla din')) return { day: shift(-1), label: 'yesterday' };
  if (has(t, ['tomorrow', 'tmrw', 'tmr'])) return { day: shift(1), label: 'tomorrow' };
  if (has(t, ['parso', 'parson', 'परसों'])) return direction === 'past' ? { day: shift(-2), label: 'the day before yesterday' } : { day: shift(2), label: 'the day after tomorrow' };
  if (has(t, ['kal', 'कल'])) return direction === 'past' ? { day: shift(-1), label: 'yesterday' } : { day: shift(1), label: 'tomorrow' };

  const month = (offset) => {
    const y = today.getUTCFullYear();
    const m = today.getUTCMonth() + offset;
    const from = new Date(Date.UTC(y, m, 1));
    const end = new Date(Date.UTC(y, m + 1, 0));
    return { from, to: offset === 0 ? today : end };
  };
  if (hasSeq(text, 'last month') || hasSeq(text, 'pichle mahine') || hasSeq(text, 'pichhle mahine') || hasSeq(text, 'previous month')) {
    return { ...month(-1), label: 'last month' };
  }
  if (hasSeq(text, 'this month') || hasSeq(text, 'is mahine') || hasSeq(text, 'iss mahine') || has(t, ['month', 'mahine', 'mahina'])) {
    return { ...month(0), label: 'this month' };
  }
  if (hasSeq(text, 'last week') || hasSeq(text, 'pichle hafte') || hasSeq(text, 'pichhle hafte')) {
    return { from: shift(-7 - ((today.getUTCDay() + 6) % 7)), to: shift(-1 - ((today.getUTCDay() + 6) % 7)), label: 'last week' };
  }
  if (hasSeq(text, 'this week') || hasSeq(text, 'is hafte') || hasSeq(text, 'iss hafte') || has(t, ['week', 'hafte', 'hafta'])) {
    const monday = shift(-((today.getUTCDay() + 6) % 7));
    return direction === 'past' ? { from: monday, to: today, label: 'this week' } : { from: today, to: shift(6), label: 'the next 7 days' };
  }
  if (has(t, ['year', 'saal', 'session'])) return { label: 'this session', session: true };

  for (const token of t) {
    if (token in WEEKDAY_WORDS) {
      const target = WEEKDAY_WORDS[token];
      let diff = (target - today.getUTCDay() + 7) % 7;
      if (direction === 'past') diff = diff === 0 ? 0 : diff - 7;
      return { day: shift(diff), label: WEEKDAYS[target] };
    }
  }
  return null;
}

// "8B", "8-B", "10 A" after "class", "class 10", "class 10th". Returns { class, section } or null.
function parseClass(text) {
  const raw = normalize(text).replace(/(\d)(st|nd|rd|th)\b/g, '$1');
  const roman = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10, xi: 11, xii: 12 };
  let m = raw.match(/\b(?:class|kaksha|grade|std)\s+(\d{1,2}|nursery|lkg|ukg|[ivx]{1,4})(?:\s*([a-h]))?\b/);
  if (m) {
    let cls = m[1];
    if (roman[cls]) cls = String(roman[cls]);
    else if (!/^\d+$/.test(cls)) cls = cls.toUpperCase();
    return { class: cls, section: m[2] ? m[2].toUpperCase() : '' };
  }
  // Without the word "class" the section must be attached ("8B") or dashed ("8-B"), so "10 a" in a sentence is ignored.
  m = String(text || '').match(/\b(\d{1,2})(?:\s?-\s?)?([A-Ha-h])\b/);
  if (m) return { class: m[1], section: m[2].toUpperCase() };
  return null;
}

const OTHER_CHILD_WORDS = ['other', 'second', 'doosre', 'dusre', 'dusri', 'doosri', 'dono', 'both', 'chhote', 'bade', 'younger', 'elder'];
const BOTH_WORDS = ['dono', 'both', 'all', 'sabhi', 'sab'];

// Which of a parent's children the question is about.
//   names match on any word of the child's name (typo-tolerant for longer names)
//   "doosre bachche" / "other child" means the child not discussed last
//   "dono" / "both" means every child
// Returns an array of children (possibly empty when nothing points at a child).
function pickChildren(text, children, lastStudentId) {
  if (!children.length) return [];
  const tokens = tokenize(text);
  const named = children.filter((c) => tokenize(c.name).some((w) => w.length >= 3 && tokens.some((t) => closeEnough(t, w))));
  if (named.length) return named;
  if (children.length > 1 && has(tokens, BOTH_WORDS)) return children;
  if (children.length === 2 && lastStudentId && has(tokens, OTHER_CHILD_WORDS)) {
    return children.filter((c) => String(c._id) !== String(lastStudentId));
  }
  return [];
}

// A person's name mentioned with "sir", "madam", "ma'am", "ji", "teacher" - used by HR questions from admins.
function personHint(text) {
  const m = normalize(text).match(/\b([a-zऀ-ॿ]{3,})\s+(?:sir|madam|maam|mam|ji|teacher|miss)\b/);
  if (m && !['class', 'meri', 'mere', 'mera', 'hamare', 'humare', 'your', 'my', 'the'].includes(m[1])) return m[1];
  return null;
}

// Pronouns and short follow-ups that point back to the previous topic ("uski?", "and for her?").
const FOLLOW_UP_WORDS = ['uski', 'uska', 'uske', 'unki', 'unka', 'unke', 'iski', 'iska', 'iske', 'his', 'her', 'their', 'that', 'same', 'also', 'bhi', 'aur', 'and', 'what', 'about'];
const looksLikeFollowUp = (text) => {
  const t = tokenize(text);
  return t.length <= 6 && (has(t, FOLLOW_UP_WORDS) || has(t, OTHER_CHILD_WORDS));
};

module.exports = { parseWhen, parseClass, pickChildren, personHint, looksLikeFollowUp, WEEKDAYS, DAY };
