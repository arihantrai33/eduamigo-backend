# AI Revision: how it works and how to set it up

## Flow
1. A teacher uploads a PDF for a class (for example `10-A`, or `10` for every section) from **Upload Materials**.
2. Every 5 minutes the note processing job picks up new notes (one server claims each note, so nothing is processed twice),
   extracts the text, splits it into chunks, embeds them with Gemini and stores them in `noteembeddings`
   together with `school`, `class`, `section` and `subject`.
   - `processing.status` on the note shows `pending`, `processing`, `ready`, `failed` (retried up to 3 times) or `skipped`
     (scanned PDF with no text).
3. A student asks a question. The server takes **school, class and section from the student's profile** (never from the request),
   searches only that class's chunks, and answers only from them. The answer is adapted to the class level.
   Modes: `explain` (default) and `quiz` (one question at a time, active recall).

## Atlas Vector Search index (required)
Create (or edit) the index named `vector_index` on the `noteembeddings` collection with this JSON definition:

```json
{
  "fields": [
    { "type": "vector", "path": "embedding", "numDimensions": 3072, "similarity": "cosine" },
    { "type": "filter", "path": "school" },
    { "type": "filter", "path": "class" },
    { "type": "filter", "path": "section" },
    { "type": "filter", "path": "subject" }
  ]
}
```

`section` must be a filter field. Without it the search fails.

## Tuning
- `REVISION_MIN_SCORE` (default `0.75`): chunks below this similarity are ignored. If students often get
  "not in your notes" for questions that are in the notes, lower it by 0.05 at a time. If answers bring in
  unrelated material, raise it.
- `REVISION_HOURLY_LIMIT` (default 40): questions per student per hour.

## Known limits
- Scanned or handwritten PDFs have no text layer and are marked `skipped`. Ask teachers to upload typed PDFs.
- Diagrams inside PDFs are not understood (text only).
