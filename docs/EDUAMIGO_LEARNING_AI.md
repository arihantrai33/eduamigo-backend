# EduAmigo AI: Ask and Learning AI (audit, design, verification)

Status as of 2026-10-14, local development only. Nothing here is deployed. Numbers come from the tests and runs named
below, not from real use.

## 1. Audit: what existed before this work

| Area | Found in the code | Gap |
|---|---|---|
| EduAmigo Ask | `src/assistant/`: one model call to understand a message, then a keyword check of that reading (`router.js`). 13 topics (`domains.js`), each read from records by its own skill (`skills/*.js`). Tickets go through a planner and action contracts (`planner.js`, `actions/`). Each answer has a trace and a log (`trace.js`, `AssistantQuery`). Providers: Azure OpenAI, then Gemini (`llm.js`). Routing eval: 290 questions. | No topic for studying. A failing skill turned the whole reply into a 500 error. |
| Revision AI | `/api/revision/ask` and the page "Revise with AI" (`/student/revise`). It answered only from the class notes. Needs Gemini embeddings and Atlas Vector Search. Two modes: explain and quiz. | Nothing outside the notes. Does not run on a local or test database (no `$vectorSearch`). No maths checking, no sources shown, no history, no voice. The quiz had no answer keys and no marking. |
| Notes and material | `Note` (title, subject, class, section, type), `NoteEmbedding` (text chunks with school, class, section and subject). `noteProcessingJob` extracts the text from PDFs. | Chunks keep no page numbers, so page references are not possible. |
| School documents | BM25 search over `SchoolDocument` sections, with evidence quotes (`services/knowledge.js`). | — |
| Voice | Nothing, on the backend or the frontend. | — |
| Web search | Nothing. No search provider is configured. | — |
| Speech, maths and diagram libraries | None installed. `react-markdown` is installed. | — |
| Configured providers (names only) | `AZURE_OPENAI_*`, `GEMINI_API_KEY`. `MONGO_URI` is set in `.env`; it is never used by the tests or by this work. | — |

### Root cause: why study requests became tickets
The understanding prompt listed **"a doubt about a lesson"** under the kind `forward`, meaning a question only a person can
answer. That kind creates a ticket for the subject teacher. There was also no study topic, so "photosynthesis samajh
nahi aa raha", "chapter 3 revise karna hai" or "solve 2x+3=11" were either forwarded to a teacher (with a model) or fell
through to "unclear" (without one). An "unclear" message becomes a ticket after the third try.

### Fix (backend commit 47e82ab)
- New topic `learning` and new kind `learn`.
- `forward` now covers only a message the person explicitly asks to have passed on.
- The server overrules the model: a `forward` about studying stays `forward` only when the message itself has pass-on
  words (`asksToPassOn`: "bolo", "tell", "message", "meet", ...).
- The keyword fallback routes study words to `learning`.
- Ask answers study questions with a short tutor answer. Students also get "Continue in AI Tutor".
- Without a model, Ask says so and sends nothing to anyone.
- "Maths teacher ko bolo ki mera doubt clear kare" still creates a ticket.
- Tests: `tests/learning.test.js` ("Ask: study help ..."). With the server override removed, the two forward cases
  create tickets and fail.
- Keyword routing eval before and after: identical. 276 questions, routing 93.5%, action 92.8%, no new failures.

### Also fixed in Ask
A failure while reading records (for example a database timeout) is now action `error` for that part only:
"I could not check the fees records just now ... This is not a 'no records' answer, and nothing was changed". The other
parts of the message are still answered. It is never shown as "nothing found".

**Not done this session:** the wider Ask upgrade (comparisons, trends and multi-step follow-ups across every module). The
existing 13 skills are unchanged apart from the failure handling above.

## 2. Architecture

```
EduAmigo Ask  POST /api/assistant/ask   (all roles, plan feature ai_assistant)
  understand -> topic + kind -> records skill | ticket action | learning skill (short tutor answer, never a ticket)

Learning AI   /api/learning/*           (students only, plan feature ai_revision)
  chat (NDJSON stream)  ->  learning/tutor.js
     materials.js   school notes for the student's own school, class and section
                    (Atlas vector search, or BM25 over the stored chunks)
     llm.stream     Azure OpenAI, then Gemini, cancellable; falls back before the first token
     mathcheck.js   re-computes ```check blocks, or the calculation extracted from a worked answer
     diagram.js     validates ```diagram JSON; the app draws it
     confidence.js  reliability note from evidence
  practice / plan / progress  ->  learning/practice.js, learning/planner.js
```

Shared between the two: `llm.js` (providers, timeouts, cool-off), the tutor (Ask's learning skill calls
`teach({ brief: true })`) and the language detection.

Kept separate:
- Ask's record tools never run inside Learning AI.
- Learning AI has no access to marks, fees or attendance.
- Its routes check `authorizeRoles('student')`.
- School, class and section always come from the student's profile on the server.

## 3. School material first, then general knowledge
1. **School material.** Passages are shown to the model as quoted data (`<<< >>>`), never in the system prompt, and cited
   as `[S1]`. Only passages the answer actually cites are listed as sources; a passage found but not cited is not
   claimed.
2. **General knowledge.** Used when the notes do not cover the question. The answer must say it is a general
   explanation and must not claim the school teaches it that way.
3. **Calculations.** Checked by the server (section 5).

The app shows the note's title, type, subject and "part N" (its text chunk). It does not show page numbers, because the
stored chunks do not have them.

## 4. Web research: not implemented (blocker)
No search provider is configured, and adding one (Bing, Google or a similar paid API) needs the owner's approval.
- The tutor's prompt forbids URLs and invented sources.
- `/api/learning/context` reports `capabilities.webResearch: false`.
- No answer claims to have searched the web.

Before this can be built: choose and approve a provider, and decide on school-level controls and on what student data
must never be sent (none should be). After that, add a search step behind the same "quoted data" handling, with source
names, links and dates taken from the search results.

## 5. Reliability, maths and visuals
- **Reliability** (`confidence.js`) is built only from evidence: cited school passages, whether the notes were searched,
  and the calculation checks. Levels:
  - **High confidence**: the answer cites school material, or its calculation was checked.
  - **Moderate confidence**: a standard explanation, with the reason (the notes do not cover it, notes were not
    searched, or the asker is not a student).
  - **Needs verification**: a calculation failed its check.
  There are no percentages, because nothing has been calibrated. A passed check says so explicitly: "This checks the
  calculation, not every statement in the explanation."
- **Maths** (`mathcheck.js`):
  - Its own parser with exact fractions (BigInt), percentages, powers, roots and trigonometry in degrees. No `eval`.
  - Limits on length, nesting and exponent size.
  - Checks a value or substitutes into an equation.
  - Anything it cannot evaluate is "unsupported", never "passed".
  - Measured on the live model: the model does not always write the check block. A worked numerical answer without
    one gets one short JSON call that extracts the calculation (the model writes an expression, never a verdict), and
    the server evaluates it.
- **Diagrams** (`diagram.js`, `Diagram.jsx`):
  - Six shapes: number line, bar chart, function graph, flow, cycle, table.
  - Validated with limits. A graph is sampled on the server with the safe parser.
  - The app draws it with its own SVG. No HTML, SVG or script from the model is ever rendered.
  - Every diagram has a text description.
  - Not supported: labelled science pictures and image generation (not configured).

## 6. Practice & Assessment and Revision Planner
- **Practice** (`practice.js`): practice only, never graded by the school.
  - Before a set is shown:
    - numeric questions need a calculation check that passes;
    - multiple-choice keys must be one of four distinct options, and a second model call answers the questions without
      seeing the keys; a disagreement drops the question;
    - short answers need marking points;
    - questions given recently are dropped.
  - Keys and solutions stay on the server until the student answers.
  - Marking:
    - multiple choice by the option chosen;
    - numbers by value (3/4 = 0.75 = 75%; "12 cm" and "x = 4" are read as numbers);
    - short answers by the model against the marking points, judging meaning, not wording.
  - A short answer that cannot be marked is not recorded.
  - A hint after the first wrong try; the solution when right, after three tries, or on request.
  - The next difficulty follows the score (80% or more: up; under 50%: down).
- **Planner** (`planner.js`): fixed rules, no model.
  - The exam date comes from the student or from the school's exam schedule (`ExamSchedule`); it is never guessed.
  - Topics weak in practice (under 60% with at least 3 answers) come first and get an extra practice session.
  - Each topic: a study session, then practice two or three days later, with a review day before the exam.
  - When there is not enough time, the topics that do not fit are named in a warning.
- **Progress**: practice accuracy by topic (weak or strong only after 3 answers), recent sets, tutor chats and plan
  progress.

## 7. Voice Learning (browser speech services)
- Speech to text uses the browser's SpeechRecognition (English India or Hindi). Chrome and Edge send the audio to their
  speech service; Safari uses Apple's.
- The answer is read by the device's speechSynthesis, sentence by sentence as it streams. Markdown, `[S1]`, links and
  code are not read, and maths is said in words.
- A privacy notice appears before the first use. EduAmigo receives only the text; no audio is stored.
- Clear messages for: permission off, nothing heard, no microphone, network, unsupported browser. Nothing is sent when
  nothing was recognised. Mute, stop speaking, stop the answer, and typing at any time.
- **Tested** with a scripted stand-in for the speech services (`e2e/learning.spec.js`): privacy notice, the spoken
  question in the same chat (`voice: true`), the answer read without symbols, permission denied, silence, mute,
  stopping speech, unsupported browser, and that latency is recorded.
- **Not tested:** real speech recognition (no microphone in headless tests), Hindi and Hinglish recognition quality,
  mobile browsers, and the Android and iOS apps (their web views may not offer SpeechRecognition; typing is the
  fallback there). Hinglish is not a separate recognition language: "English (India)" usually writes Hindi words in
  Roman letters.

## 8. Latency (measured 2026-10-14)
A live run from this Mac to the configured Azure OpenAI deployment (gpt-4.1-mini). 12 tutor answers (6 questions × 2,
English, Hinglish, Hindi, maths, spoken, follow-up) and 6 understanding calls. No database, no school-material search.

| Step | p50 | p95 | n |
|---|---|---|---|
| Tutor: question to first token | 933 ms | 3,592 ms (the first, cold connection) | 12 |
| Tutor: whole answer | 1,460 ms | 4,323 ms | 12 |
| Ask: understanding call | 1,537 ms | 1,658 ms | 6 |

- p95 from 12 samples is close to the maximum. These are small samples, not production numbers.
- All 6 study questions were read as `learn/learning` by the live model.
- The extra calculation call (section 5) adds about one short call after the answer has finished streaming.
- School-material search (BM25) runs in a few milliseconds in the tests.
- **Voice:** from the end of speech to the first text and to the first sound is recorded in the app
  (`data-voice-first-text-ms`, `data-voice-first-audio-ms`) but has **not been measured on a real device**.
- Remaining bottlenecks:
  - the model's first token (about 0.9 s);
  - Ask's understanding call before its answer;
  - the first connection after idle;
  - the browser's speech recognition deciding that you have stopped speaking.

## 9. Security and isolation (tested)
- Learning routes are for students only; parents, teachers and admins get 403.
- The `ai_revision` plan feature is required.
- Another student's conversation, practice set or plan gives 404, in the same school and across schools.
- School material: only the student's school, class and section, plus whole-class material. Tested with decoys: another
  section, class 9 and another school.
- Notes reach the model only as quoted data in the user message.
- Practice keys are not in any response before answering, and the verification call does not see them.
- Model output is never rendered as HTML; diagrams are data; a `<script>` diagram is dropped.
- Expressions are never `eval`'d.
- The tenant guard (`enforce`) covered every new query in the tests.
- Routine tests never call a paid provider: backend tests mock `fetch`, and the frontend test backend runs with
  `ASSISTANT_AI=off`.

## 10. Tests and results (2026-10-14)
- Backend `npm test`: **773/773** (41 suites; 40 new in `learning.test.js` and `learning-units.test.js`).
- Frontend `npm run test:e2e`: **55/55**, including 13 new in `learning.spec.js` and `learning-integration.spec.js`.
- Build ok. 0 lint messages on changed lines.
- Responsive sweep on the test servers: 150 screenshots, 0 JS errors, 0 page-level sideways scroll.
- Live provider checks, run by hand and not part of any suite:
  - the latency run above;
  - two answers read for quality (Hinglish fractions, a discount problem). Both were correct; the discount answer was
    checked by the server (45 / (90/100) = 50).

## 11. Dependencies, configuration, approvals
- No new packages.
- New optional settings:
  - `LEARNING_VECTOR_SEARCH` (`auto`/`on`/`off`);
  - `LEARNING_HISTORY_DAYS` (default 180; conversations are deleted automatically by a TTL index).
- New collections: `learningconversations`, `practicesessions`, `revisionplans`. They need no migration.
- Plan usage: tutor answers and practice sets count against the school's monthly `aiQuestionsPerMonth`.
- Needs approval:
  - a web search provider;
  - any change to which providers or models are used;
  - deploying any of this.

## 12. Remaining work, safest next step
1. Have a teacher and two or three students try the AI Tutor and Practice locally on the demo, with real notes uploaded
   (needs the note processing job and a Gemini key for embeddings, or the BM25 path with chunk text).
2. Try voice on a real Android phone and an iPhone in Chrome and Safari, and record the latency attributes.
3. Write a labelled evaluation set for study questions (correctness, language, honesty about sources). There is no
   accuracy number yet.
4. The wider Ask upgrade (section 1). Web research once a provider is approved.
5. Page numbers: store the page with each chunk when notes are processed.
