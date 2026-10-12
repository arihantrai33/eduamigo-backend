# EduAmigo: Product and Engineering Audit (read-only)

Date: 2026-10-12. Branch audited: `feature/eduamigo-ask` (commit fd2b27d). Repositories: `eduamigo-backend`, `eduamigo-frontend`, `eduamigo-console`.
Method: read the code, ran the real test suite with coverage, ran `npm audit`, built the frontend, queried the live Render and Vercel account (read-only). No code, data or deployment was changed. No secret values are quoted.

Labels: **[Observed]** checked in code or by a command. **[Assumed]** inferred, not proven. **[Rec]** recommendation.

## 1. Executive assessment

EduAmigo is a real multi-tenant school platform, not a demo. The backend has about 15,000 lines across 43 models and 30 route files, a plan/entitlement system, audit log, billing invoices, year-end processing and an AI assistant with a measured evaluation. 610 automated tests pass.

The main gap is not features. It is that **none of this is running anywhere**: the live site is the old June build, and the SaaS release has never been deployed or exercised against a real database with real traffic. The next risks are operational (monitoring, shared rate limits, backups, frontend tests) rather than architectural.

Verdict: **not yet production-ready.** It is a strong release candidate, and deploying it to staging is the correct next step.

## 2. Verified stack and architecture [Observed]

- Backend: Node (CI on 24, `engines` >= 20), Express 5, Mongoose 9, MongoDB Atlas. One modular monolith: routes, controllers, services, models, jobs, assistant. No microservices.
- Security libraries: helmet, express-rate-limit, jsonwebtoken, bcryptjs, multer. Payments: Razorpay with HMAC webhook check. Files: Cloudinary. Bus tracking: Firebase Realtime DB (server writes). Email: Resend or Brevo. AI: Azure OpenAI then Gemini fallback.
- Frontend: React 19 + Vite, PWA, about 25,000 lines, inline styles with CSS variables for school branding. Owner console: separate small app (2 commits).
- Hosting (live): Render free plan (`eduamigo-backend`, auto-deploys `main`, Oregon), Vercel (`eduamigo-frontend`). Two older Python prototypes also run on Render (`school-saas`, `school-saas-1`).
- Live backend runs commit 0cd27e3 (old `main`). Its `/api/health` returns only `{"status":"ok"}`, which is the old response. The SaaS release is 71 commits ahead and undeployed.

## 3. Modules and status [Observed: code and tests exist; not deployed]

| Area | Status |
|---|---|
| Schools, plans, add-ons, entitlements, subscription states (past_due, read_only, suspended) | Implemented, tested |
| Platform owner API and console | Implemented; console app is thin (2 commits) |
| Login by school code, roles, password reset, sign-out-everywhere | Implemented, tested |
| Students, teachers, parents, classes, academic sessions, year-end, transfer certificates | Implemented, tested |
| Attendance, timetable, leaves, events, announcements, notifications | Implemented |
| Fees, fee structures, Razorpay payments, invoices | Implemented, tested (no live gateway test) |
| Exams, marks, report cards | Implemented, tested |
| Admissions, HR/salary, library, chat | Implemented, gated by plan |
| Transport and bus tracking | Implemented; depends on Firebase config and a driver app |
| AI revision from notes | Implemented; needs an Atlas Vector Search index |
| EduAmigo Ask / UnifiedAI | Implemented, with evaluation (see section 7) |
| Backups, migration script | Implemented, tested |

## 4. Authentication, authorization, tenant isolation

Strengths [Observed]:
- `protect` loads the user, then attaches `req.schoolId`, entitlements and subscription state to every request; client-supplied school IDs are not trusted.
- 42 of 43 models carry a `school` field (only `PasswordReset` does not; it is keyed by user). By-id lookups in controllers and services are on `School` itself or on documents already fetched through a school-scoped query.
- Entitlements are enforced on the server (`requireFeature`, `gated(...)` in `app.js`). Read-only mode blocks writes for expired schools.
- Token revocation through `tokenVersion` and `passwordChangedAt`. Platform admin login is separate. Webhook signature uses timing-safe compare.
- 17 tenant/cross-school related tests exist across 10 test files, plus an access-matrix test.

Gaps:
- **[Assumed] Isolation is proven by tests and a heuristic grep, not by a systematic guarantee.** Any new query that forgets `school` leaks silently. [Rec] Add a Mongoose plugin or query helper that requires a school filter on tenant models, and a test that fails if a tenant model is queried without one.
- **CORS opens to every origin when `CORS_ORIGINS` is unset**, and production startup only requires `MONGO_URI` and `JWT_SECRET`. [Rec] Require `CORS_ORIGINS` in production.
- **Rate limits are in memory.** They reset on every restart or deploy and are not shared between instances. There is no global per-IP limit; only login, password reset, assistant, revision and public lookup are limited. [Rec] Shared store (Mongo or Redis) and a global limit.
- **Session tokens last 7 days and live in browser localStorage.** An XSS bug would expose them. [Rec] Shorter access token with refresh, or httpOnly cookies, and a content-security-policy.
- **File uploads trust the client MIME type** with a size limit; there is no content (magic-byte) check. [Rec] Verify file signatures.
- Password policy is length 8 only. [Rec] Acceptable now; add breached-password check later.

## 5. Database and data integrity

- 35 model files define indexes; 32 unique constraints; migration script rebuilds per-school unique indexes [Observed].
- **No Mongo transactions anywhere** [Observed]. Payment application uses an atomic claim on the order, which is the right idea for the main money path. Multi-document flows (year-end promote/detain, onboarding a school) rely on being re-runnable instead of atomic. [Rec] Review year-end for partial-failure recovery.
- Atlas M0 backups are the project's own `npm run backup` script (JSON dump). There is no point-in-time recovery on the free tier. [Rec] Move to a paid tier before real schools.
- Repo hygiene: a `_to_delete` folder with old git bundles (3 MB) sits in the working tree and may hold history from before the secret was removed. [Rec] Delete after confirming secrets were rotated.

## 6. Dependencies and supply chain [Observed]

`npm audit` (production dependencies): 9 findings.
- 1 critical: `proxy-addr` (transitive via Express). A non-breaking fix is available (`npm audit fix`). [Rec] Apply and re-run tests.
- 8 moderate: all through `firebase-admin`. Fix needs a major upgrade (14.x). [Rec] Schedule separately and test the bus-tracking path.

## 7. EduAmigo Ask / UnifiedAI

[Observed] One endpoint (`POST /api/assistant/ask`), gated by plan and rate-limited per hour. Pipeline: language-model understanding plus keyword scoring, a confidence gate (answer, clarify, or hand to office), deterministic skills reading school records, BM25 search over the school's documents, tickets as the only write action, idempotent ticket creation, owner-scoped lookups, a safe fallback when the model is down. Security and prompt-injection tests exist (`assistant-security`, `assistant-hardening`).

Measured by the project's own evaluation (documented in `docs/UNIFIEDAI_CURRENT_STATE.md`): routing about 95% on 290 labelled questions, about 92.5% on holdout, about 93-97% on unseen sets. The 125-question answer set was repaired until it passed, so it is a regression guard, not an accuracy estimate.

Limits [Observed from the docs]: evaluated on demo data, not on real school traffic; actual resolution rate is unknown. Only tickets are written; the assistant does not change fees, attendance or other records, which is the correct boundary.

## 8. Frontend UX and consistency

- Build succeeds. **0 automated tests** across about 25,000 lines [Observed].
- **ESLint reports 178 errors and 20 warnings** [Observed]. Memory notes say many are the accepted "setState in effect" pattern; the rest are not triaged.
- Theming is consistent through CSS variables; status and grade colours are fixed on purpose [Observed from earlier work].
- [Assumed] Accessibility (keyboard, contrast, screen readers) has not been audited.
- The Vercel `VITE_API_URL` is shared by Production and Preview, so previews hit the live API.

## 9. Tests

[Observed] 29 suites, 610 tests, all passed in this audit. Coverage: statements 80.2%, branches 65.1%, functions 77.7%, lines 85.3%. Controllers 76% statements, middleware 88%. CI runs the suite against real MongoDB 7 on Node 24. Gaps: no frontend tests, no load tests, no end-to-end tests against a deployed environment, no test with a real Razorpay, Firebase or Cloudinary account.

## 10. Deployment, monitoring, recovery

- Deployment guide exists (`docs/DEPLOYMENT.md`). Staging blueprint added (`render.staging.yaml`).
- **No error tracking, no structured logging, no request IDs** outside the assistant [Observed]: 19 `console.*` calls in runtime code, no Sentry/pino-type tool. Health check reports DB status only. [Rec] Structured logs with request ID, plus an error tracker and an uptime check, before onboarding schools.
- Cron jobs run inside the web process. The fee reminder has no per-day dedupe, so **two instances would send duplicates** [Observed]. Note-processing uses a lock and is safe. Render free also sleeps after idle time, which delays the first request and can skip the 9:00 cron [Assumed].
- No documented rollback beyond restoring the backup script output.

## 11. Performance, scalability, cost

- Render free plan sleeps and has no SLA; Atlas M0 has storage and connection limits. Fine for staging, not for paying schools [Rec: paid tiers].
- AI cost is bounded by hourly limits per user. Embeddings are re-generated by a job after migration; cost on first run is unmeasured [Assumed].
- No caching layer, so none of the tenant-leak risk that comes with one [Observed].
- No load test has been run. [Rec] Run a basic one on staging for login, list endpoints and `/ask`.

## 12. Technical debt

1. Two older Python prototypes still deployed on Render (`school-saas`, `school-saas-1`).
2. `_to_delete/` folder and `test-revision.sh` in the repo root.
3. Frontend lint errors and zero frontend tests.
4. Console app is minimal.
5. The branch history is long-lived: 71 commits unmerged to `main`; `hardening/saas-foundation` was never pushed.

## 13. Prioritised roadmap

| # | Item | Severity | Effort |
|---|---|---|---|
| 1 | Deploy to staging, run migration, smoke-test (in progress; blocked on Atlas and gh login) | Blocker | S |
| 2 | Rotate secrets, back up, migrate production, merge to `main` | Blocker | S |
| 3 | Require `CORS_ORIGINS` in production; `npm audit fix` for `proxy-addr` | High | XS |
| 4 | Error tracking, structured logging with request IDs, uptime check | High | S |
| 5 | Shared rate-limit store and a global limit | High | S |
| 6 | Tenant-scope guard (plugin plus failing test) | High | M |
| 7 | Paid Atlas and Render tiers, backup schedule, restore drill | High | S |
| 8 | Frontend: smoke tests for login, fees and Ask; triage lint errors | Medium | M |
| 9 | Token lifetime and storage hardening, upload signature check, CSP | Medium | M |
| 10 | Cron dedupe or move to a single worker | Medium | S |
| 11 | firebase-admin major upgrade | Medium | S |
| 12 | Clean up prototypes and `_to_delete` | Low | XS |

## 14. Not verified

Real-device behaviour of the PWA; Razorpay, Firebase, Cloudinary and email in a live account; the Atlas Vector Search index state; the actual env vars on Render (the CLI token and `.env.example` could not be read); data currently in the live database; accessibility; load behaviour.
