// The school's written documents as an answer source for EduAmigo Ask: splitting a document into sections and
// finding the sections that answer a question.
//
// Retrieval is BM25 over the sections of the school's own documents (a school holds a few dozen documents, so no
// vector database is needed, and it behaves the same in production, tests and the local demo). A question is searched
// with the model's plain-English restatement as well as the person's own words. Only sections that share enough
// distinctive words with the question are returned; if nothing does, the answer is "the school has not written
// this down", never a guess.

const SchoolDocument = require('../models/SchoolDocument');
const { tokenize } = require('../assistant/text');

const MAX_DOCS_PER_SCHOOL = 60;
const MAX_TEXT = 120000;
const SECTION_TARGET = 700;

const STOP = new Set(('the a an is are was were be been am of to in on at for and or but if so as by with from this that these those it its ' +
  'what which who whom whose when where why how do does did can could should would will shall may might must my me i you your we our they their he she his her ' +
  'about any there here please tell show give know want need get ' +
  // words that frame a question about documents without saying what it is about
  'policy policies rule rules information info detail details regarding related guideline guidelines ' +
  'kya hai hain tha thi the ho hoga hogi ka ki ke ko se me mein par pe aur ya bhi to toh kab kaun kaunsi kaunsa kaise kitna kitni kitne ' +
  'batao bataiye bataye mujhe mera meri mere hamara hamari school').split(' '));

// A light stemmer: plurals and the common endings, so "refundable", "refunded" and "refunds" all meet "refund".
const stem = (t) => {
  if (t.length <= 3 || !/^[a-z]+$/.test(t)) return t;
  let w = t;
  if (/ies$/.test(w) && w.length > 4) w = `${w.slice(0, -3)}y`;
  else if (/(ses|xes|zes|ches|shes)$/.test(w)) w = w.slice(0, -2);
  else if (/s$/.test(w) && !/(ss|us|is)$/.test(w)) w = w.slice(0, -1);
  for (const end of ['able', 'ible', 'ing', 'ed', 'ly']) if (w.endsWith(end) && w.length - end.length >= (end === 'ing' ? 3 : 4)) { w = w.slice(0, -end.length); break; }
  // "time", "timing" and "timings" are one word: a final silent "e" is dropped on both sides of the match.
  if (w.length > 3 && w.endsWith('e')) w = w.slice(0, -1);
  return w;
};
const terms = (text) => tokenize(text).filter((t) => t.length >= 2 && !STOP.has(t)).map(stem);

// "1. Heading", "HEADING", "# Heading" or "Heading:" on a line of its own start a new section.
const isHeading = (line) => {
  const l = line.trim();
  if (!l || l.length > 90) return false;
  return /^#{1,4}\s+\S/.test(l) || /^\d{1,2}[.)]\s+[A-Z]/.test(l) || (/^[A-Z][A-Z0-9 &/,'-]{3,}$/.test(l)) || /^[A-Z][^.!?]{2,60}:$/.test(l);
};

// Text -> [{ heading, text }]. Long sections are cut on paragraph or sentence boundaries.
function splitSections(raw) {
  const text = String(raw || '').replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_TEXT);
  const sections = [];
  let heading = '';
  let body = [];
  const flush = () => {
    const joined = body.join('\n').trim();
    if (joined.length > 15) {
      const pieces = joined.split(/\n\n+/);
      let current = '';
      for (const piece of pieces) {
        if ((current + '\n' + piece).length > SECTION_TARGET && current) { sections.push({ heading, text: current.trim() }); current = piece; } else current = current ? `${current}\n${piece}` : piece;
      }
      if (current.trim().length > 15) {
        // A single very long paragraph: cut at sentence ends.
        while (current.length > SECTION_TARGET * 2) {
          const cut = current.lastIndexOf('. ', SECTION_TARGET * 1.5);
          const at = cut > SECTION_TARGET / 2 ? cut + 1 : SECTION_TARGET * 1.5;
          sections.push({ heading, text: current.slice(0, at).trim() });
          current = current.slice(at);
        }
        sections.push({ heading, text: current.trim() });
      }
    }
    body = [];
  };
  for (const line of text.split('\n')) {
    if (isHeading(line)) { flush(); heading = line.trim().replace(/^#{1,4}\s+/, '').replace(/^\d{1,2}[.)]\s+/, '').replace(/:$/, '').slice(0, 200); } else body.push(line);
  }
  flush();
  return sections.slice(0, 400);
}

// Documents this person may be answered from.
async function visibleDocuments(school, role) {
  const q = { school, isActive: true };
  if (role !== 'admin') q.$or = [{ audience: { $size: 0 } }, { audience: role }];
  return SchoolDocument.find(q).limit(MAX_DOCS_PER_SCHOOL).lean();
}

// queries: the person's words and the model's English restatement; expand: the model's synonyms. Returns the best sections, best first:
// [{ documentId, title, category, heading, text, updatedAt, score, matched }]
async function search({ school, role, queries, expand = [], limit = 3 }) {
  const docs = await visibleDocuments(school, role);
  const primary = [...new Set(queries.filter(Boolean).flatMap(terms))].slice(0, 16);
  // Synonyms suggested by the model help a section match, but do not raise how many words a question must share.
  const q = [...new Set([...primary, ...expand.filter(Boolean).flatMap(terms)])].slice(0, 24);
  if (!docs.length || !q.length) return [];

  const units = docs.flatMap((d) => d.sections.map((s) => {
    const body = terms(s.text);
    const head = terms(s.heading);   // the section's own heading counts double
    const title = terms(d.title);    // the document title says little about one section, so it counts half
    return { d, s, body, head, title, len: body.length + head.length };
  })).filter((u) => u.len);
  if (!units.length) return [];
  const avg = units.reduce((a, u) => a + u.len, 0) / units.length;
  const N = units.length;
  const df = (t) => units.filter((u) => u.body.includes(t) || u.head.includes(t) || u.title.includes(t)).length;

  const K1 = 1.4; const B = 0.75;
  const scored = units.map((u) => {
    let score = 0;
    const matched = [];
    for (const t of q) {
      const inBody = u.body.filter((x) => x === t).length + 2 * u.head.filter((x) => x === t).length;
      const tf = inBody + (u.title.includes(t) ? 0.5 : 0);
      if (!tf) continue;
      // A word found only in the document title is a weak match for this section.
      if (inBody) matched.push(t);
      const n = df(t);
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += idf * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + B * (u.len / avg))));
    }
    return { u, score, matched };
  });

  // Enough shared words: two distinctive words, or the only one a short question has.
  const need = Math.min(2, primary.length);
  // A single shared word is enough when it is rare in this school's documents ("uniform" appears in one or two sections).
  const rare = (t) => t.length >= 5 && df(t) <= 2;
  return scored
    .filter((x) => x.matched.length >= need || x.matched.some(rare))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ u, score, matched }) => ({
      documentId: String(u.d._id), title: u.d.title, category: u.d.category, heading: u.s.heading, text: u.s.text,
      updatedAt: u.d.updatedAt, score: Math.round(score * 100) / 100, matched,
    }));
}

module.exports = { splitSections, search, visibleDocuments, MAX_DOCS_PER_SCHOOL, MAX_TEXT, terms };
