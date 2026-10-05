# API architecture

Request path: `helmet` and CORS -> JSON parsing (1 MB) -> router -> `protect` (JWT, active user, school, entitlements) ->
`requireFeature` / `requirePermission` / `authorizeRoles` -> controller (validation, row-level rules) -> service -> model ->
JSON. Errors reach one handler that returns `{ success: false, message }` and never a stack trace.

The full mount table (30 route files, 214 endpoints) is in `PROJECT_UNDERSTANDING.md` and is generated from the code.

## EduAmigo Ask endpoints

| Method | Path | Who | Notes |
|---|---|---|---|
| GET | `/api/assistant/intro` | school users | topics for the role and starter questions |
| POST | `/api/assistant/ask` | school users, 120 per hour | `{ message, conversationId?, choice?: { type, value } }` |
| POST | `/api/assistant/feedback` | the asker | `{ queryId, helpful }`; only on one's own question |
| GET | `/api/assistant/tickets?scope=mine\|assigned\|all&status=` | school users (`all`: `assistant.insights`) | |
| PATCH | `/api/assistant/tickets/:id` | assignees and admins | `{ status?, note? }`; the sender is notified |
| GET | `/api/assistant/metrics?days=` | `assistant.insights` | |
| GET | `/api/assistant/evaluation` | `assistant.insights` | routing evaluation, calibration, answer-quality report |
| GET, POST | `/api/assistant/knowledge` | `assistant.knowledge` (admin) | list; add (JSON text or multipart PDF, 10 MB) |
| PATCH, DELETE | `/api/assistant/knowledge/:id` | `assistant.knowledge` | edit text, switch on or off, remove |

`ask` returns `{ conversationId, queryId, language, replies[] }`. A reply: `domain`, `label`, `confidence`, `method`
(keywords, model, context, choice, rule), `action` (answer, clarify, handoff, blocked, no_data), `text`, `sources[]`
(`type`, `label`, `id`, `at`, `evidence` for documents), `link`, `actions`, `options`, `ticket` (`number`, `team`, `sentTo`).

## Known inconsistencies

* Login returns `token` and `user` at the top level; other endpoints wrap in `data`.
* Some older list endpoints are unpaginated; newer ones use `utils/paginate.js`.
* Business rules for older modules still sit in some controllers rather than services (the assistant and billing use services).
