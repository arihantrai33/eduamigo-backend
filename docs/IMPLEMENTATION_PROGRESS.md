# Implementation progress

Read this first in a new session, then check `git status` and the code: this file can be out of date.

## Current phase
Audit and PS-18 hardening of EduAmigo Ask (UnifiedAI) is implemented and measured on branch `feature/eduamigo-ask` (backend and
frontend). Nothing is deployed. Next: staging deployment and a rehearsal on the Allied International School, Gaya copy.

## Completed (verified by tests or live runs)
* Understanding and audit of both repositories; findings table in `PROJECT_UNDERSTANDING.md`.
* Understanding of each message by one model call (topic, kind, child, class, subject, person, about whom, exam view, language,
  restatement, search words); keyword router as fallback; reconcile rules.
* Answers written for the exact question (composer) with number and name checks; Hinglish, Hindi and English; human tone.
* Hand-off to named people (named teacher, subject teacher from the timetable, class teacher, accountants, office) with a summary.
* Authorization: scope refusal for other students and "everyone"; tapped choices re-validated; 11 prompt-injection and malformed
  model tests (`tests/assistant-security.test.js`).
* School documents as a knowledge source: model, admin API, admin screen, BM25 retrieval, audience filter, citations with
  evidence and update time; demo documents for the demo schools.
* Metrics: outcome-based resolution, real grounding fields, confidence calibration, saved answer-quality report on the dashboard.
* UI: bot avatar, typing indicator, word-by-word reveal, evidence cards, professional suggestions, inline resolve notes,
  error boundary, shorter splash, SPA rewrite and security headers (`vercel.json`).

## In progress / remaining
* Staging deployment (Render and Vercel) and a check of `VITE_API_URL`, CORS origins and Azure variables there.
* Add demo documents to the Gaya copy from the admin screen before the rehearsal (the real-data copy has none).
* Replace the historical double parent link (`Student.parentUserId` and `Parent.children`) with one.
* Upgrade `firebase` (frontend) and `firebase-admin` (backend) to clear the audit advisories, then re-test bus tracking.
* Content-security-policy for the frontend, after testing against Firebase, map tiles and Cloudinary.
* Embeddings for school documents only if a school uploads a large document set.

## Architectural decisions
* Model-first understanding, keyword fallback (keyword lists do not scale to new wording; measured 72% on fresh questions).
* Facts from the database, wording from the model, every number and name checked, standard answer as fallback.
* One front door: no manual domain choice; clarification only for real ambiguity.
* BM25 over a school's own document sections instead of a vector database (small corpora, no extra infrastructure, works in demo).
* Confidence: kept as the model's number raised by keyword agreement; its calibration is measured, not assumed. A rule that
  would ask whenever the model and the words disagree was simulated on the labelled set and rejected (it changed 1 question and
  no result).
* Resolution counts outcomes (grounded answer not repeated, ticket resolved by staff), not found topics.

## Known issues
See "Remaining limitations" in `EVALUATION.md` and the open rows of the audit table in `PROJECT_UNDERSTANDING.md`.

## Test results
See `EVALUATION.md` (numbers are copied from the saved reports) and run `npm test`.

## Next step
Deploy to staging, run `npm run assistant:answers` against it, rehearse the demo scenarios in `PS18_REQUIREMENTS.md`.
