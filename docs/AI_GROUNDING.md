# How EduAmigo Ask stays grounded

Rule: the model may choose and phrase, never invent. A fact reaches the person only if the database (or a school document)
supplied it.

## Three layers

1. **Retrieval of facts (deterministic).** A skill reads the school's own collections, filtered by school and by the asker, and
   returns `facts` (numbers, names, dates) plus a standard English answer. For documents, BM25 over the school's own sections
   returns the best passages, and only passages that share enough distinctive words with the question (`services/knowledge.js`).
2. **Composition (model, checked).** `compose.js` receives the question, the facts and the standard answer and writes the
   answer to what was asked, in the person's language. Before it is shown:
   * every number in it must appear in the facts, the standard answer or the question or today's date;
   * every name (a capitalised word) must appear there too; the first word of a sentence counts as a name only when followed by a
     title or a particle (`Priya madam`, `Rohit ki`), and a surname after it is checked on its own;
   * length is bounded;
   * otherwise the standard answer is shown and the event is logged as `kept_original` (the dashboard shows its rate).
3. **Honesty about gaps.** If the facts do not hold what was asked, the composer returns `answered: false` and says what is
   known; the person is offered the right teacher by name, not a guess. Documents that do not answer a question give "the
   school has not shared a written answer", never a general-knowledge reply about the school.

## What a source is
`{ type, label, id, at, evidence? }`: the kind of record, a readable label, the record id, when it was last updated, and for
documents the quoted passage. Sources are built from the records that were read, not from the model's text.

## General questions
Greetings and general knowledge (not about the school) get a short model answer with a rule never to state school facts.

## Known limits
* The fact check proves numbers and names, not meaning: a model could, in principle, flip "not refundable" to "refundable"
  without adding a number. The composer prompt forbids it, the standard answer is the fallback, and the answer-quality
  evaluation checks wording on controlled questions, but this is not a proof.
* Retrieval for documents is lexical. A question that uses none of the document's words (and has a poor English restatement)
  finds nothing and is offered to the office. Embeddings can be added if schools upload large document sets.
* Scanned PDFs have no text and are refused with a clear message.
