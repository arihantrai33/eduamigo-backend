# UnifiedAI: implementation progress

Read this first in a new session, then run `git status`, `git log` and `npx jest`: this file can be out of date. State of the
code: `UNIFIEDAI_CURRENT_STATE.md`. Design: `UNIFIEDAI_ARCHITECTURE.md`. Requirements: `PS18_REQUIREMENTS.md`. Measurements: `EVALUATION.md`.

## Branch and status
`feature/eduamigo-ask` in both repositories (backend `eduamigo-backend`, frontend `eduamigo-frontend`). Nothing is deployed, nothing
is merged to `main`. Last verification: 2026-10-06, 570 backend tests pass, frontend build passes.

## Completed (against the master directive)

| Directive phase | Status | Where |
|---|---|---|
| 0-1 Inspect repo, document current state | done | `PROJECT_UNDERSTANDING.md`, `UNIFIEDAI_CURRENT_STATE.md` |
| 2 Architecture document | done | `UNIFIEDAI_ARCHITECTURE.md` |
| 3 Conversation manager (coreference, bounded memory, redaction) | done | `conversation.js` |
| 4-5 Generalised NLU, structured intent and entities, English/Hindi/Hinglish | done (model-first, keyword fallback) | `router.js` |
| 6 PS-18 routing, real confidence, clarify | done, calibrated (ECE 0.02) | `router.js`, `engine.js`, `eval.js` |
| 7 Multi-intent with partial-failure tolerance | done | `engine.js` |
| 8 Modular domain skills | done (12 skills + documents) | `skills/` |
| 9 Grounding / RAG with evidence | done (lexical retrieval) | `compose.js`, `services/knowledge.js` |
| 10-11 Action orchestration, tool/action contracts | done (ticket actions) | `actions/`, `planner.js` |
| 12 Action verification, no unconfirmed success | done | `actions/index.js`, `actions/messages.js` |
| 13 Ticket lifecycle (dedupe, follow-up, escalate, reopen, resolve, status) | done | `planner.js`, `actions/ticketActions.js`, `controllers/assistantController.js` |
| 14 Professional staff handoff, original preserved | done | `handoff.js`, `router.js` brief, `AssistantTicket` |
| 15 Priority by policy | done | `policy.js` |
| 16 RBAC and injection safety | done, 11 injection tests + scope tests | `assistant-security.test.js` |
| 17 Provider abstraction and error handling | done | `llm.js` |
| 18 Short-term memory | done, bounded | `conversation.js` |
| 19 Observability (request id, trace) | done, plan and action steps added this phase | `trace.js`, `AssistantQuery` |
| 20-21 Evaluation, adversarial cases | done (routing 290, answers 125, chats 12 + 8) | `eval/`, `scripts/` |
| 22 PS-18 traceability | done | `PS18_REQUIREMENTS.md` |
| 23 Existing features preserved | verified by the full suite (570 tests) | `npx jest` |
| 24 UI (ticket refs, action progress, staff summaries) | done | frontend `AskWidget.jsx`, `AskInsights.jsx` |
| 25 Self-review pass | done: defects in section 6 of the current-state doc | |

## This phase (2026-10-06)
* Evaluation refreshed on a fresh demo database; routing report and answers report saved.
* Fixed: timing questions in documents (stemmer); planner subject check in the similarity fallback; "THIS chat" ticket in model
  context and prompt; status fallback prefers the chat's ticket; plan step and message kinds in the trace.
* Evaluation script: no "0/0" line in batch mode; a partial run does not overwrite the saved full report.
* Eight new fresh conversations (`final2`) added and run once: 8/8 on a fresh database (the first run showed 5/8, all three
  failures traced to tickets left in the demo database by earlier runs; the cases were not changed).

## Remaining

Product:
* Voice input is not built.
* Server-side streaming of answers (the reveal is client-side only).
* Embeddings for documents only if a school uploads a large set.
* Slot-based replacement of the skills' remaining word lists (offered earlier; not decided).
* Replace the fixed similarity thresholds for duplicate tickets with something measured on real tickets.
* Make the escalation turn robust when the model reads it as a question (seen once in a fresh run).

Engineering:
* Staging deployment (Render + Vercel), check `VITE_API_URL`, CORS, Azure variables; run `npm run assistant:answers` against it.
* Demo documents for the Gaya (real data) copy via the admin screen.
* Upgrade `firebase` and `firebase-admin` (advisories), then re-test bus tracking.
* CSP header for the frontend; move the token out of localStorage.
* Make the combined evaluation independent of leftover demo tickets (reset the demo database between the single-question and
  conversation sections) without changing any case.

## Decisions
* Model proposes, backend validates and executes; the reply is built from verified results.
* Priority is a policy table keyed by safety category; the model only describes the situation.
* One model call for understanding, one for writing; facts always from the database.
* BM25 over a school's own document sections instead of a vector store.
* The conversation context is compact (6 turns, 5 people, 3 tickets, the person's own recent tickets); the current chat's ticket is separate.
* Evaluation cases are never edited to improve a score; a failing case is either a product defect (fixed) or reported as an evaluation or infrastructure effect.

## How to run
```
cd eduamigo-backend && npm install
npx jest                                              # 570 tests
node src/scripts/demo.js                              # demo school GVPS on :8000, in-memory database, password Demo@1234
BASE=http://localhost:8000 node src/scripts/assistantAnswerEval.js --save          # answers + chats (restart the demo first)
BASE=http://localhost:8000 node src/scripts/assistantAnswerEval.js --batch=final2  # the fresh conversation batch
npm run assistant:eval -- --model --save              # routing, needs the model keys in .env
ASSISTANT_LOG=json node src/scripts/demo.js           # one JSON trace line per request
```
Never point the demo or the evaluation at the Atlas database.
