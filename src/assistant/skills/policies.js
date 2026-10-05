// School information skill: answers from the school's own written documents (handbook, policies, FAQs, circulars)
// that the admin has added. Every answer cites the document and section it came from and when the document was
// last updated. If the school has not written the answer down, it says so and offers to ask the school office.

const knowledge = require('../../services/knowledge');
const { day, source } = require('./util');

const excerpt = (text, n = 220) => (text.length > n ? `${text.slice(0, n).replace(/\s+\S*$/, '')}...` : text);

async function run(ctx) {
  // The person's own words and the model's restatement are both searched.
  const queries = [ctx.question, ctx.text];
  const found = await knowledge.search({ school: ctx.schoolId, role: ctx.role, queries, limit: 3 });
  if (!found.length) {
    return {
      noData: true, handoffOffer: true,
      text: 'The school has not shared a written answer to this yet. I can ask the school office for you.',
    };
  }
  const best = found[0];
  return {
    text: `${best.title}${best.heading ? ` (${best.heading})` : ''}:\n${best.text}`,
    // The passages the answer may use; the composer writes the reply from these and nothing else.
    facts: { passages: found.map((f) => ({ document: f.title, section: f.heading || null, lastUpdated: day(f.updatedAt), text: f.text })) },
    sources: found.map((f) => ({
      ...source('document', `${f.title}${f.heading ? ` · ${f.heading}` : ''}`, f.documentId, { updatedAt: f.updatedAt }),
      evidence: excerpt(f.text),
    })),
  };
}

module.exports = { run, needsStudent: false };
