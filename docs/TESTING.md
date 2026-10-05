# Testing

`npm test` (570 tests in 28 suites on 2026-10-06; Jest, supertest, in-memory or local MongoDB per test file via `tests/globalSetup.js`). The suite covers
authentication, access matrix, tenancy, every paid module, payments, billing, migration, backup, year-end, and EduAmigo Ask.

| File | What it proves |
|---|---|
| `assistant.test.js` | one front door (several topics), clarify, hand-off, complaints versus complaint questions, access control, tenancy, metrics, evidence |
| `assistant-model.test.js` | model-first routing (mocked model), composer grounding, forwarding to named teachers, Hinglish answers, provider fallback |
| `assistant-security.test.js` | an obedient (attacked) model cannot make the assistant show another student, another person's salary or another class; malformed model output is harmless |
| `assistant-knowledge.test.js` | document sections, admin-only management, tenant isolation, audience restriction, citations, "not written down" |
| `assistant-conversation.test.js` | conversation memory (bounded, redacted), planner (follow-up, repeat, escalate, reopen, status, overruled claims, subject), action verification and honest failure replies, professional staff briefs, policy priority, provider failure, request trace, context handed to the model |
| `assistant-metrics.test.js` | resolution is computed from outcomes (grounded answers, staff-resolved tickets, abandoned clarifications), with hand-checked numbers |

Beyond unit and API tests:

* `npm run assistant:eval -- --model --save`: routing accuracy, per-topic precision and recall, confidence calibration, on
  290 labelled questions split into development, holdout, unseen and fresh sets (see `EVALUATION.md`).
* `node src/scripts/assistantAnswerEval.js --save` (needs the demo on port 8000; restart it first, because tickets from earlier runs
  change what the assistant does: it adds to an existing ticket instead of opening a new one): asks the questions as a parent,
  student, teacher and admin and checks facts, forbidden facts, actions, hand-off recipients, ticket outcomes, staff briefs and
  multi-turn conversations. `--conversations` runs only the chats, `--batch=final2` only the fresh batch; neither overwrites the saved report.
* Frontend: `npm run build` and `npm run lint` (older screens still have lint findings unrelated to the assistant).
  Screens were checked in headless Chrome at 390 px.

Not covered by automated tests: the React components (no component test runner is set up), Razorpay live payments, push
notifications, and the live Azure model (the answer-quality evaluation is the check for that).
