# EduAmigo: what the product is and how it works

This document describes the application as it exists in the repository (backend `eduamigo-backend`, frontend
`eduamigo-frontend`, both on branch `feature/eduamigo-ask`). It was written from reading the code, not from memory.

## What EduAmigo is

A multi-school SaaS for running a school: students, parents, teachers and administrators sign in to one app, each
to their own portal. One deployment serves many schools. Every record belongs to a school, and every request is
limited to the signed-in person's school (`req.schoolId`).

| Layer | Technology |
|---|---|
| Backend | Node.js, Express 5, Mongoose (MongoDB), JWT, bcrypt, helmet, express-rate-limit, node-cron |
| Frontend | React 19 and Vite, react-router, TanStack Query, lucide icons, Leaflet (bus map), Firebase client (live bus) |
| Database | MongoDB (Atlas in production; an in-memory MongoDB for `npm run demo` and tests) |
| AI | Azure OpenAI (gpt-4.1-mini) first, Google Gemini as fallback; Atlas Vector Search for the AI Revision feature |
| Integrations | Razorpay (online fee payments), Cloudinary (uploads), Firebase Admin (bus tracking, push), email provider |
| Hosting (planned) | Render (API) and Vercel (frontend); see `DEPLOYMENT.md`. Nothing is deployed yet |

## The journey of a user, from the first screen

1. **Splash** (`pages/Splash.jsx`): brand screen, then it decides where to go: signed in, to the person's portal; school
   chosen on this device, to that school's sign-in; otherwise to "find your school".
2. **Find the school** (`/select-school`, `/s/:code`): public school lookup (`/api/public`, rate limited) or a school link.
3. **Sign in** (`/login`, `POST /api/users/login`): school code plus identifier (staff email, student admission number,
   parent mobile) and password. The server returns a JWT. First-login accounts must change their password.
4. **Session** (`context/AuthContext.jsx`, `utils/session.js`): the token and profile are kept in `localStorage`; on every
   app start the profile is refreshed from the server (plan, features, permissions, branding). Any `401` or a suspended
   school signs the person out and returns them to the login screen.
5. **Role and authorization**: the frontend sends each role to its own portal (`Protected` in `App.jsx`); the backend is the
   authority: `protect` verifies the token, loads the user and school, checks the subscription, and attaches
   `req.user`, `req.schoolId`, `req.entitlements`. Routes then check a role, a permission (`requirePermission`) or a plan
   feature (`requireFeature`). Row-level rules (a teacher only their classes, a parent only their children) are in
   controllers and in `services/directory.js`.
6. **Portal and modules**: student, parent, teacher, admin (also used by accountants), and a login-less driver page.
7. **A user action** becomes an API call (axios with the bearer token), a route, a controller, models, and a JSON
   response; the screen updates from the response. The EduAmigo Ask button is present on every portal screen.

## Roles

`superadmin` (platform owner, separate token scope, `/api/platform` only), `admin`, `accountant`, `teacher`, `student`,
`parent`, `driver`. Permissions are defined once in `src/config/permissions.js`; the human matrix is in
`ACCESS_CONTROL.md`. Features a school has not bought are removed from its permission list and refused by the API
(`FEATURE_NOT_IN_PLAN`).

## Modules that exist

Core (every plan): students, teachers, parents, classes and sections, attendance, timetable, notice board and notifications,
calendar, leave requests, study material, bulk upload and promotion, academic sessions and year-end.
Paid (plan or add-on): fees and billing, online payments, exams and report cards, admissions, HR and payroll, transport and
live bus, library, parent-teacher chat, AI Revision, EduAmigo Ask. Platform: schools, plans, add-ons, billing, support
sessions, audit log.

## API surface (generated from `src/app.js` and `src/routes`)

| Mount | Plan feature | Route file | Endpoints | Auth | Permissions used |
|---|---|---|---|---|---|
| `/api/public` | - | publicRoutes | 3 | public / per-route | - |
| `/api/platform` | - | platformRoutes | 18 | JWT | - |
| `/api/users` | - | userRoutes | 11 | JWT | users.manage |
| `/api/schools` | - | schoolRoutes | 7 | JWT | settings.manage |
| `/api/academic` | - | academicRoutes | 13 | JWT | academics.manage |
| `/api/audit` | - | auditRoutes | 1 | JWT | audit.read |
| `/api/students` | - | studentRoutes | 7 | JWT | students.manage, students.read |
| `/api/teachers` | - | teacherRoutes | 4 | JWT | teachers.manage, teachers.read |
| `/api/parents` | - | parentRoutes | 6 | JWT | parents.manage, parents.read |
| `/api/attendance` | - | attendanceRoutes | 10 | JWT | attendance.mark, attendance.reports |
| `/api/timetable` | - | timetableRoutes | 8 | JWT | timetable.manage |
| `/api/leaves` | - | leaveRoutes | 7 | JWT | leaves.all, leaves.review |
| `/api/notifications` | - | notificationRoutes | 6 | JWT | communication.manage |
| `/api/announcements` | - | announcementRoutes | 6 | JWT | communication.manage |
| `/api/events` | - | eventRoutes | 4 | JWT | communication.manage |
| `/api/bulk` | - | bulkRoutes | 5 | JWT | bulk.manage |
| `/api/notes` | - | noteRoutes | 6 | JWT | notes.upload |
| `/api/payments` | - | paymentRoutes | 6 | JWT | fees.read, settings.manage |
| `/api/transport` | - | transportRoutes | 15 | JWT | transport.manage |
| `/api/fees` | fees | feeRoutes | 8 | JWT | fees.collect, fees.read, fees.structure |
| `/api/fee-structures` | fees | feeStructureRoutes | 7 | JWT | fees.read, fees.structure |
| `/api/exams` | exams | examRoutes | 9 | JWT | exams.manage, results.read |
| `/api/marks` | exams | markRoutes | 6 | JWT | exams.manage, marks.enter |
| `/api/report-cards` | exams | reportCardRoutes | 3 | JWT | marks.enter, results.read |
| `/api/admissions` | admissions | admissionRoutes | 6 | JWT | admissions.manage |
| `/api/hr` | hr | hrRoutes | 9 | JWT | hr.manage |
| `/api/library` | library | libraryRoutes | 5 | JWT | library.manage |
| `/api/chat` | chat | chatRoutes | 10 | JWT | chat.directory |
| `/api/revision` | ai_revision | revisionRoutes | 1 | JWT | - |
| `/api/assistant` | ai_assistant | assistantRoutes | 7 | JWT | assistant.insights |

## Data model (generated from `src/models`)

| Model | References | Declared indexes |
|---|---|---|
| AcademicSession | School | 2 |
| AddOn | - | 0 |
| Admission | School, Student, User | 2 |
| Announcement | School, User | 0 |
| AssistantConversation | School, Student, User | 2 |
| AssistantQuery | AssistantConversation, AssistantTicket, School, User | 2 |
| AssistantTicket | School, Student, User | 4 |
| Attendance | School, Student, User | 2 |
| AuditLog | School, User | 2 |
| Broadcast | School, User | 0 |
| BulkUpload | - | 0 |
| Conversation | School, User | 1 |
| Counter | School | 1 |
| Event | - | 0 |
| ExamResult | ExamSchedule, School, Student, Teacher | 2 |
| ExamSchedule | School, User | 2 |
| Fee | FeeStructure, PaymentOrder, School, Student, User | 2 |
| FeeStructure | School, User | 1 |
| Invoice | School, User | 2 |
| LeaveRequest | School, Student, User | 1 |
| Library | School, User | 1 |
| Mark | ExamSchedule, School, Student, Teacher | 2 |
| Message | School, User | 2 |
| Note | School, User | 2 |
| NoteEmbedding | Note, School | 1 |
| Notification | School, User | 1 |
| Parent | School, Student, User | 2 |
| PasswordReset | User | 2 |
| PaymentOrder | Fee, School, Student, User | 1 |
| Plan | - | 0 |
| ReportCardRemark | School, Student, User | 1 |
| Salary | School, Teacher | 1 |
| School | - | 2 |
| SchoolClass | School, Teacher | 1 |
| StaffLeave | School, Teacher, User | 0 |
| Student | School, Transport, User | 4 |
| StudentEnrollment | School, Student | 2 |
| Teacher | School, User | 2 |
| Timetable | School, Teacher | 1 |
| Transport | School, Student | 0 |
| UsageCounter | School | 1 |
| User | School | 2 |

## Existing AI before EduAmigo Ask

* **AI Revision** (`/api/revision`, feature `ai_revision`): a student chats about their own class notes. Teachers' PDF notes
  are chunked and embedded (Gemini embeddings), stored in `NoteEmbedding`, searched with MongoDB Atlas Vector Search
  filtered by school, class, section and subject, and answered by Gemini with a "notes only" system prompt. A low-score
  search says the notes do not cover it. This is a separate, working RAG for study help and is left as it is.
* **EduAmigo Ask** (`/api/assistant`, feature `ai_assistant`): the PS-18 assistant; see `UNIFIEDAI_ARCHITECTURE.md`.

## Audit findings (verified by reading code and running it)

| # | Area | Finding | Evidence | Status |
|---|---|---|---|---|
| 1 | Secrets | `serviceAccountKey.json` is on disk | it is git-ignored and was never committed (`git log` shows no history for it) | not a leak; keep ignored |
| 2 | AI authorization | Asking about another student, or about "everyone", was answered with the asker's own record, silently. A teacher asking for "admin ki salary" got their own salary | live probes against the demo | **fixed**: refusal in `engine.js` (`scopeRefusal`), tests in `tests/assistant-security.test.js` |
| 3 | AI authorization | Model output (child, class, person, topic) was only partly validated | code review | **checked and tested**: every model field is matched against the asker's real records; 10 injection tests |
| 4 | Metrics | `grounded` was hard-coded `true` in the query log; resolution counted any answer as resolved | `engine.js`, `metrics.js` | **fixed**: outcomes-based resolution, real `composition` and `grounded` fields |
| 5 | Metrics | Confidence was the model's own number, never checked | `router.js reconcile` | **measured**: calibration table in the evaluation (see `EVALUATION.md`) |
| 6 | PS-18 | No document or policy source: rules, timings, uniform, refund policy all went to "ask the office" | `domains.js`, skills | **fixed**: school documents (`SchoolDocument`), retrieval, citations |
| 7 | Safety | The word "refund" turned any refund-policy question into an urgent ticket | `router.js` SENSITIVE | **fixed**: the model judges a payment dispute; the word list keeps only unambiguous safety terms |
| 8 | UX | `window.prompt` used for ticket notes | `AskWidget.jsx`, `AskInsights.jsx` | **fixed**: inline note fields |
| 9 | UX | A render error anywhere blanked the whole app | no error boundary | **fixed**: `ErrorBoundary` around the app and the assistant |
| 10 | UX | Splash always waits 3 s, even for a signed-in person | `Splash.jsx` | **fixed**: 1.2 s when already signed in |
| 11 | Dependencies | Backend: 8 moderate advisories (all under `firebase-admin` / Google Cloud client libraries). Frontend: 4 high (`firebase` client, `@grpc/grpc-js` via Firestore, which the app does not use) | `npm audit --omit=dev` | open; fixes need a major `firebase` upgrade, see "Known issues" |
| 12 | Hygiene | `_to_delete/` (git bundles) and `Claude outputs/` sit untracked in the repo folder | `git status` | open: move out of the folder |
| 13 | Session | The token is kept in `localStorage` (readable by any script on the page) | `AuthContext.jsx` | accepted for now; httpOnly cookies would need a CSRF design; helmet and a strict CSP reduce the risk |
| 15 | Deployment | `vercel.json` rewrote only a few paths, so refreshing `/select-school`, `/s/:code` or `/forgot-password` would return 404 on Vercel; no security headers | read `vercel.json` | **fixed**: catch-all SPA rewrite, `nosniff`, frame, referrer, HSTS and permissions headers; a CSP is still to add |
| 16 | Metrics | A different question on the same topic within 10 minutes (the other child's fees) was counted as a repeat, lowering resolution | simulated on live log | **fixed**: a repeat needs similar wording |
| 17 | AI | A Roman-letter question could be answered in Devanagari, with transliterated names that escape the name check | live probe | **fixed**: such an answer is rejected |
| 14 | Frontend | Lint reports pre-existing issues in older screens | `npm run lint` | open, unrelated to the assistant |
