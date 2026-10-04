// Library skill: the catalogue (Library). The school records copies, not who borrowed them,
// so questions about a person's borrowed books are passed to the librarian.

const Library = require('../../models/Library');
const { tokenize, hasPhrase } = require('../text');
const { DOMAINS } = require('../domains');
const { plural, link, source, escapeRegex } = require('./util');

const FILLER = new Set(['is', 'are', 'the', 'a', 'an', 'in', 'of', 'do', 'you', 'have', 'there', 'any', 'available', 'hai', 'hain', 'kya', 'mein', 'me',
  'ki', 'ka', 'ke', 'koi', 'milegi', 'milega', 'mil', 'sakti', 'sakta', 'chahiye', 'copies', 'copy', 'how', 'many', 'kitni', 'kitne', 'by', 'wali', 'wala', 'please', 'batao', 'show', 'search', 'find']);
const BORROW_WORDS = ['my books', 'meri kitab', 'meri book', 'borrowed', 'issued to me', 'return date', 'due date', 'fine', 'jama karni'];

async function run(ctx) {
  if (hasPhrase(ctx.text, BORROW_WORDS)) {
    return { noData: true, handoffOffer: true, text: 'Book issue and return dates are kept by the librarian, not in the app yet. I can pass your question to the librarian.' };
  }
  const terms = new Set(DOMAINS.library.terms.flatMap(([p]) => tokenize(p)));
  const words = tokenize(ctx.text).filter((w) => w.length >= 3 && !terms.has(w) && !FILLER.has(w));
  if (words.length) {
    const re = words.map(escapeRegex).join('|');
    const books = await Library.find({ school: ctx.schoolId, $or: [{ title: { $regex: re, $options: 'i' } }, { author: { $regex: re, $options: 'i' } }] }).limit(20).lean();
    // Best matches first: books matching more of the words.
    const score = (b) => words.filter((w) => new RegExp(escapeRegex(w), 'i').test(`${b.title} ${b.author || ''}`)).length;
    const ranked = books.sort((a, b) => score(b) - score(a)).slice(0, 5);
    if (ranked.length) {
      return {
        text: `${ranked.map((b) => `- ${b.title}${b.author ? ` by ${b.author}` : ''}: ${b.available > 0 ? `${b.available} of ${b.totalCopies} available` : 'all copies are issued'}`).join('\n')}`,
        facts: { search: words.join(' '), books: ranked.map((b) => ({ title: b.title, author: b.author || null, available: b.available, total: b.totalCopies })) },
        sources: ranked.slice(0, 3).map((b) => source('book', `Library · ${b.title}`, b._id)),
        link: link('library', ctx.role),
      };
    }
    return { text: `The library has no book matching "${words.join(' ')}".`, facts: { search: words.join(' '), books: 0 }, sources: [source('catalogue', 'Library catalogue')], link: link('library', ctx.role) };
  }
  const [agg] = await Library.aggregate([{ $match: { school: ctx.schoolId } }, { $group: { _id: null, titles: { $sum: 1 }, copies: { $sum: '$totalCopies' }, available: { $sum: '$available' } } }]);
  if (!agg) return { text: 'No books have been added to the library catalogue yet.', facts: { titles: 0 }, sources: [] };
  return {
    text: `The library has ${plural(agg.titles, 'title')} (${agg.copies} copies); ${agg.available} copies are on the shelf and ${agg.copies - agg.available} are issued. Ask for a book by its name to check it.`,
    facts: { titles: agg.titles, copies: agg.copies, available: agg.available, issued: agg.copies - agg.available },
    sources: [source('catalogue', 'Library catalogue')],
    link: link('library', ctx.role),
  };
}

module.exports = { run, needsStudent: false };
