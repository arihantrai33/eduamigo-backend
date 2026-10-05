# Testing

`npm test` (Jest, supertest, in-memory or local MongoDB per test file via `tests/globalSetup.js`). The suite covers
authentication, access matrix, tenancy, every paid module, payments, billing, migration, backup, year-end, and EduAmigo Ask.

| File | What it proves |
|---|---|
| `assistant.test.js` | one front door (several topics), clarify, hand-off, complaints versus complaint questions, access control, tenancy, metrics, evidence |
| `assistant-model.test.js` | model-first routing (mocked model), composer grounding, forwarding to named teachers, Hinglish answers, provider fallback |
| `assistant-security.test.js` | an obedient (attacked) model cannot make the assistant show another student, another person's salary or another class; malformed model output is harmless |
| `assistant-knowledge.test.js` | document sections, admin-only management, tenant isolation, audience restriction, citations, "not written down" |
| `assistant-metrics.test.js` | resolution is computed from outcomes (grounded answers, staff-resolved tickets, abandoned clarifications), with hand-checked numbers |

Beyond unit and API tests:

* `npm run assistant:eval -- --model --save`: routing accuracy, per-topic precision and recall, confidence calibration, on
  290 labelled questions split into development, holdout, unseen and fresh sets (see `EVALUATION.md`).
* `npm run assistant:answers -- --save` (needs `npm run demo` running): asks the questions as a parent, student, teacher and
  admin and checks facts, forbidden facts, actions, hand-off recipients and multi-turn conversations.
* Frontend: `npm run build` and `npm run lint` (older screens still have lint findings unrelated to the assistant).
  Screens were checked in headless Chrome at 390 px.

Not covered by automated tests: the React components (no component test runner is set up), Razorpay live payments, push
notifications, and the live Azure model (the answer-quality evaluation is the check for that).
