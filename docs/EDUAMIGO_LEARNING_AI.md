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
- Added later: a stale or duplicate send is ignored, Escape stops speaking/listening/the answer, starting the mic during an
  answer interrupts it, an answer that arrives only as final text is still read, and `?voicedebug=1` shows the measured
  delay on the device (first text, first sound, both counted from the end of speech).
- Voice quality (2026-10-14, after owner feedback that Hindi/Hinglish sounded foreign and like reading): the cause was that
  a Hinglish answer was spoken by the English voice and written like a document. Now (1) Hindi and Hinglish answers use the
  best installed Hindi voice (natural/neural/premium/Google ranked first, robotic voices never), (2) a voice question gets a
  spoken-teacher prompt: short sentences, a natural opener, one example, no lists or labels, a closing question, and Hindi
  in Devanagari with English school words in English letters, (3) rate 0.92 (Hindi) / 0.97 (English). Quality still depends
  on the voices installed on the device (Edge's Natural/Neural Hindi voices are best; Chrome uses Google/Apple voices). A
  device with no Hindi voice is told so. A studio-quality voice would need a provider-billed speech service (not
  implemented, needs approval and cost metering).
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
- Backend `npm test`: **804/804** (42 suites). New: `ai-usage.test.js` (26 tests: metering, limits, cache, concurrency,
  admin summary, intents, language, zero use) and more in `learning.test.js`.
- Frontend `npm run test:e2e` (own backend and web server on 8110/5184, `ASSISTANT_AI=off`, mocked AI answers): **68/68**,
  including `learning-completion.spec.js` (follow-up buttons, duplicate send, Escape, voice timing, AI-off banner,
  graph legend, concept map, long cycle steps, re-teach, admin AI usage tab).
- Build ok; ESLint clean on the changed frontend files (the backend has no ESLint configuration).
- Mocked tests and the real-provider run (section 14) are separate evidence. Routine tests never call a provider.

## 11. Dependencies, configuration, approvals
- No new packages.
- Optional settings:
  - `LEARNING_VECTOR_SEARCH` (`auto`/`on`/`off`);
  - `LEARNING_HISTORY_DAYS` (default 180; conversations are deleted automatically by a TTL index);
  - `AI_PRICING` (JSON, see section 13; nothing is priced without it);
  - `AI_WARN_AT` (default 0.8), `AI_MAX_CONCURRENT_PER_USER` (default 1), `AI_USAGE_DAYS` (ledger retention).
- New collections: `learningconversations`, `practicesessions`, `revisionplans`, `aiusages`. No migration is needed.
- Needs approval: a web search provider; any change to providers or models (including a stronger model for hard
  questions); a provider-billed voice service; deploying any of this.

## 12. Remaining work, safest next step
1. Teacher uploads real notes locally, then check "revise my notes" with the real provider (the demo's only note has no
   processed text, so this was only verified with a mocked provider).
2. Try voice on a real Android phone and an iPhone (Chrome, Safari) with `?voicedebug=1` and record the timings.
3. Set `AI_PRICING` on the real deployment from the provider's current price page (only then can a cost budget be
   enforced), and set provider-side spend limits too.
4. A labelled evaluation set for study questions (there is no accuracy number yet).
5. Web research and provider-billed voice, once approved. Page numbers per chunk.

## 13. Usage metering and cost control
**What is counted.** Every provider call (and every answer served from the cache, as a cache hit with no tokens) writes
one `AiUsage` row: school, user, month, feature (`ask`, `tutor`, `tutor_verify`, `practice`, `practice_verify`,
`practice_mark`, `embeddings`, `revision_legacy`), provider, model, tokens in/out, whether the tokens were estimated
(only when the provider sent none), voice flag, duration, ok/failed, estimated cost. **No question, answer or key is
stored.** Rows expire by TTL. Nothing is recorded unless a call is made, so ordinary ERP use (fees, attendance, notices,
reading the Learning screens) adds no row and no cost; a school that never uses the AI has no variable AI charge.

**Cost is an estimate.** `estimate = tokens x price`, with prices only from `AI_PRICING`:
`{"currency":"USD","models":{"azure:gpt-4.1-mini":{"inputPer1M":<n>,"outputPer1M":<n>}}}`. There are no built-in prices.
Unpriced calls show "not priced". The provider's actual invoice is not retrieved (`actualProviderBilling: null`); the
provider's own billing page and spend limit are a separate control from this app-side metering.

**Limits per school** (set by the platform owner on the plan or the school, `PATCH /api/platform/schools/:id/subscription`):
`aiQuestionsPerMonth` (existing), `aiBudgetPerMonth` (only enforced when prices are configured; otherwise the admin page
says it cannot be enforced), `aiTokensPerMonth`, and `featureQuotas {ask, tutor, practice}`. A question counts once; the
calculation check and answer-key check calls inside it count towards tokens and budget only.
- At 80% a warning appears for the school admin. At 100% paid calls stop: the AI Tutor and Practice answer HTTP 429
  `AI_LIMIT` with a plain message; EduAmigo Ask keeps working on keywords (`ai.used:false`).
- Per person: one AI answer at a time (`AI_BUSY` 429 for an overlapping request), the existing rate limiter, an output
  token cap per answer, and no automatic retry beyond the provider fallback.
- The generic-answer cache is keyed by school, class, language, mode, message and the school's notes version, so nothing
  crosses schools and a changed note drops the cached answer.
- Routing: model-free paths come first (intent replies for practice/plan/contact-teacher, cache hits, Ask's keyword
  router). There is **one** configured model; a stronger model for hard questions is **not implemented** and needs approval.

**Admin view.** `GET /api/ai-usage/summary?month=YYYY-MM` (school admin with `assistant.insights`; other roles 403, no
token 401) and the admin page Ask > "AI usage and cost": month, calls, tokens, estimated cost or "not priced", cache
hits, failed calls, per-feature table, limits with state, alerts, the voice note, and the "not the provider's invoice" note.

**Voice.** Spoken questions use the browser's own speech service (not billed by EduAmigo's provider). A provider-billed
voice session is not implemented; if one is added it must be metered as `audioSeconds` and given its own limit.

## 14. Real-provider smoke test (2026-10-14, local, isolated)
Isolated demo backend on port 8110 (temporary data), `ASSISTANT_AI` not set to off, Azure OpenAI gpt-4.1-mini from the
existing `.env` (no key printed), `LEARNING_VECTOR_SEARCH=off`. About 25 provider calls in total.

| Scenario | Result |
|---|---|
| English question (photosynthesis) | Answered by Azure; first text 1.8 to 2.7 s, whole answer 3.7 to 4.4 s; "Moderate confidence" because no school notes matched. |
| "explain it again in a simpler way" | Same conversation; a new analogy, not a repeat; first text about 1.0 s. |
| Hinglish "Mujhe mere notes revise karwa do" | Hinglish reply, intent `revise_notes`, no model call, no ticket. The demo note has no processed text, so the reply says the notes are not ready (before the fix it wrongly said "not uploaded"). **Revision from real notes with the real provider: not verified** (mocked only). |
| Maths: 3x + 7 = 25 | Correct steps, x = 6; server check "passed: equation", High confidence. |
| Diagram: "draw the water cycle" | **First run failed**: the model said "I cannot draw" and returned no diagram. Fixed (the prompt tells the model the app draws diagrams). After the fix a validated `cycle` diagram came back; "plot y = 2x + 1" returned a validated graph. |
| Practice set (3 questions, easy) | Created; keys not in the response; 1 to 2 generated questions were dropped by the key checks. |
| Provider failure (second isolated backend, endpoint unreachable) | Tutor: plain "could not answer, nothing was guessed"; practice: 503, no session saved, progress unchanged; Ask: keyword answer. Failed calls recorded with 0 tokens. |

**Metering and limits (same run).** The admin summary showed provider-reported token counts per feature. After a token
limit was set at 85% of usage the summary showed a warning; below usage the AI Tutor and Practice returned 429
`AI_LIMIT`, Ask answered from keywords, and **0 provider calls** were made while blocked; removing the limit restored
answers. Overlapping tutor requests from one student: the second got 429 `AI_BUSY`. 13 ordinary read and ERP requests
changed the call count 3 to 3. Cost showed "not priced" because `AI_PRICING` was not set (no price was invented).

**Browser (local Chrome, real AI, own web server on 5184).** `/student/learn` loaded the tutor input with the context
request answered 200 and no "AI is off" banner; a typed question showed its first text after about 2.4 s; a graph was
drawn from validated data with no HTML/SVG/code fences in the log. Voice used a **scripted** speech stand-in (no
microphone): first text 1,130 ms and first sound 1,147 ms after the scripted end of speech, a measurement of the app's
own delay only, **not of real speech recognition or a phone**.

**Not verified:** a real microphone, Hindi/Hinglish recognition, mobile browsers, provider-billed voice, a stronger
model, image upload, web research, the provider's actual invoice, and a cost budget with real prices.
