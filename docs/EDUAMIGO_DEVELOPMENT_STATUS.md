# EduAmigo development status

Living document for the end-to-end product mission (responsive web first, then Android and iOS). Updated after every phase.
Everything here is **local only**: nothing is pushed, deployed or migrated in production.

| Repository | Branch | Base |
|---|---|---|
| `eduamigo-backend` | `hardening/pilot-readiness` | `feature/eduamigo-ask` |
| `eduamigo-frontend` | `feature/responsive-product` | `feature/eduamigo-ask` |
| `eduamigo-console` (owner console) | `main` | |

## Phase 1: audit (2026-10-13)

Backend findings and fixes are in `docs/PRODUCT_AUDIT_2026-10-12.md`, the pilot-readiness work on this branch (tenant guard, concurrency,
receipts, private photos, isolation sweep, load tests) and `docs/STAGING_PLAN.md`. Backend suite at the start of this mission: 36 suites, 711 tests, all passing.

Frontend (observed in code and in screenshots at 375, 768, 1024 and 1440 px):

| # | Finding | Severity |
|---|---|---|
| F1 | Student, Teacher and Parent portals render inside a fixed 390 px phone frame with 40 px rounded corners on a dark background at every width (`App.jsx` AppLayout, `index.css` 430 px shell). On a tablet or desktop the app is a small phone in the middle of the screen. | High |
| F2 | Every portal page builds its own header and its own bottom navigation (10 copies of the bottom nav, 40 pages with `position: fixed`), so navigation is not shared and cannot adapt to a sidebar. | High |
| F3 | No design tokens: colours, radii, spacing and shadows are inline literals in ~24,000 lines; Tailwind is installed but not used. | Medium |
| F4 | Admin dashboard uses rainbow gradient stat cards and multicoloured quick-access tiles that ignore the school's brand. | Medium |
| F5 | Admin header on phones: the "leave pending" and profile pills wrap and crowd the title. | Low |
| F6 | Login, school selection and password pages also sit in the phone frame on desktop. | Medium |
| F7 | No frontend tests; ESLint reports 178 errors and 20 warnings (mostly the accepted fetch-in-effect pattern). | Medium |
| F8 | Owner console exists as a separate app with 2 commits; not part of this pass. | Info |

Mobile toolchains on this Mac at the start: Xcode 16.4 only. Since installed with Homebrew (free): JDK 21, the Android SDK
(platform 36), an Android emulator image, the iOS 18.6 Simulator runtime and `ios-webkit-debug-proxy`.

## Plan (dependency order)

| Step | Work | Status |
|---|---|---|
| W1 | Design tokens (`index.css`) and a shared navigation config per role | done (frontend 32dfbcd) |
| W2 | Portal shell: phone frame removed; sidebar from 1024 px, bottom navigation below; auth pages in a proper centred layout | done (32dfbcd) |
| W3 | Replace the duplicated bottom navs with one component (14 copies); widen phone-only containers and bars | done (32dfbcd) |
| W4 | Desktop layouts for the role dashboards (multi-column), then internal screens portal by portal | partly: home tiles 3 columns; internal screens fill the width; per-screen redesign pending |
| W5 | Admin: brand-consistent dashboard, server-side dashboard numbers, phone header, table overflow, chat on phones | done (frontend 19995f1, 0f1acbd; backend 6de4259) |
| W6 | Workflow verification per module (UI to API to database), fixes and tests | partly: attendance, fees, leave, notices and parent-teacher chat covered end to end; other modules covered by backend tests only |
| W7 | Frontend tests: Playwright end-to-end with the system Chrome (`npm run test:e2e`, 19 tests); mobile smoke tests (`npm run test:android`, `npm run test:ios`) | done |
| W8 | Mobile: Capacitor chosen (see frontend `docs/MOBILE.md`); Android + iOS projects; Keychain/Keystore session; FCM push (backend `services/push.js`, 9 tests); back button; deep links; safe area, status bar and keyboard handling | done for local development (emulator 14/14, Simulator 20/20). Needs people with the accounts: Firebase files and APNs key for push, signing keys, physical phones, store review |
| W9 | Final verification and handover | pending |

## Progress log
- 2026-10-13: audit done, plan written, frontend branch created.
- 2026-10-13: portals responsive (sidebar / bottom nav), one typeface (Inter, bundled), design tokens; admin dashboard
  redesigned on a new server endpoint `GET /api/schools/me/dashboard` (6 tests); teacher chat listed a parent of two
  children twice (fixed, test added); admin screens usable on phones via a scoped CSS safety net; admin chat one pane on phones.
- Screen sweep (automated, headless Chrome, in-memory demo data): 32 portal screens at 375 and 1280 px and 35 admin screens
  at 375 px. No JavaScript errors. Remaining horizontal overflow at 375 px: Ask Insights (45 px), ID card tool (fixed print size).
- Backend suite: 37 suites, 718 tests passing.
- 2026-10-13: found and fixed that many portal screens could not scroll (content below the first screen unreachable),
  a crash on the student Learn screen, a school-search limit that would block a class on one network (30/min -> 120/min),
  labels for screen readers on sign-in, attendance, payment and leave forms. 16 end-to-end tests: sign-in per role,
  role guard, sign-out, sidebar vs tabs, every screen opens without error (all four portals), every screen scrolls,
  attendance -> parent notice once, payment -> next receipt number, leave -> approval -> parent history.
- 2026-10-13: push notifications backend (devices per user, shared-phone safe, silenced by sign-out-everywhere, 9 tests;
  suite 38 suites / 727 tests). Capacitor 8 Android and iOS projects added in the frontend; JDK 21 and Android SDK 36
  installed locally with Homebrew (free); Android SDK licences accepted for the local build tools.
- 2026-10-13: frontend first download 1.89 MB -> 377 kB (screens load when first opened); one accessible dialog for the
  admin screens; chat usable with a keyboard and screen readers; EduAmigo icons and splash screens. 19 end-to-end tests.
- 2026-10-13: apps verified in the Android emulator (Android 16, API 36: 14/14 checks) and the iOS Simulator (iPhone 16,
  iOS 18.6: 20/20). Found and fixed on iPhone: content under the status bar and the home indicator, the page zooming into
  text fields, the keyboard pushing screens up under the status bar (chat header lost) and covering the message box,
  and a deleted-and-reinstalled app signing the previous person back in (iOS keeps Keychain items; a fresh install now
  starts signed out). Also: the student results page showed a phone tab bar on desktop. Release bundle (AAB) builds
  unsigned with a placeholder API address. Frontend commits bfe7c4f, 98ee923, a3972b2.

- 2026-10-13: web UI/UX transformation (frontend `docs/EDUAMIGO_WEB_UX_AUDIT.md` has the route inventory and log).
  Shared components PageHeader, PortalHeader, StatCard/StatGrid and toolbar classes; 29 admin screens moved off their
  coloured banners and colour-bordered stat cards onto the dashboard's look; four portal screens with stray white
  headers now match the rest; portals sit in a centred column on wide screens; 2.8 s Transport animation removed;
  teacher single class preselected; leave balance contrast; three admin screens no longer scroll sideways on phones.
  Full sweep after the work: 150 screenshots, 0 JavaScript errors, 0 routes with page-level sideways scroll;
  Playwright 19/19. Frontend commits b15be6f..c87c491.

- 2026-10-13 (later): owner decisions applied and the remaining web work. On phones the student and parent home
  header now scrolls with the page (desktop unchanged). The results screen uses the shared tab bar (Home, Bus, Learn,
  Chat, Me) with Learn as the current tab; no label was renamed. The last five admin screens (Chat, ID cards, Ask
  insights, Teacher Profile, Transfer Certificate) are on the design system; Teacher Profile "Edit Profile" used to
  open a route that does not exist and now opens the edit dialog. Record tables (students, teachers, parents, fees,
  fee structure, admissions, results, salaries, HR, library) become one labelled card per row on phones; report tables
  keep scrolling. Forms: silent delete/pin/approve/mark-paid failures now show a message, leave approval cannot be
  pressed twice, HR checks required fields, three hand-rolled dialogs moved to the shared one, dialogs ask before
  discarding typed-in changes, and the Add Student/Teacher/Parent pages warn before the tab is closed or reloaded.
  Playwright 24/24, build ok, 0 new lint messages. Frontend commits 2ab6301..bb32559.
- 2026-10-13: owner console (`eduamigo-console`, local commit 8b35e3a) reviewed after recording its scope. On phones
  the sidebar never collapsed and every screen scrolled sideways; it is now a top bar (0 sideways scroll on all 8
  routes at 375 and 1440 px, 0 JS errors). Turning a school off and voiding an invoice now ask first; invoice actions
  report the result; "Schools" no longer lights up with "Add a school". Void is checked by lint/build only (the demo
  plans have no price, so no invoice can be created).
- 2026-10-13: final verification and hardening pass (no redesign; details in the frontend's web UX audit).
  - Errors: 18 "Error" fallbacks and 18 raw technical messages replaced; one helper gives the server's words, plain
    advice for no connection/timeouts/401/403/404/413/429, and for a server failure the action plus a short reference
    matching this backend's request id log line. The console shows the same reference. No backend change needed: the
    error handler already hides internals on 5xx and logs them with the request id.
  - Printing, checked as PDFs: report cards printed at half width with the last line on an extra page, the receipt's
    last line fell onto page 2, the transfer certificate printed the admin sidebar and Ask button and would stop after
    one page. Fixed: full width, one page per report card/receipt, long documents continue cleanly.
  - Console invoice Void tested with a mocked platform API (Cancel sends nothing; OK voids and reports it).
  - Unsaved changes: moving to another screen inside the app now asks (router navigator guarded, as BrowserRouter
    has no useBlocker); sign-out asks before clearing the session; reload/close also asks for dialogs. Browser
    Back/Forward is not covered.
  - Tests no longer touch a running demo: Playwright starts its own on 8100/5174. Before this, test runs reused the
    owner's in-memory demo on 8000 and wrote test records into its GVPS school (cleared when that demo restarts).
  - Results: frontend Playwright 35/35 twice; console Playwright 6/6, lint and build clean; backend 727/727; frontend
    build ok, lint on changed files 70 → 64 messages; sweep 150 screenshots with 0 JS errors and 0 sideways scroll.
  - Local commits, none pushed (no upstream on any branch): frontend `feature/responsive-product` dea2606, 95bf32e,
    403714f, 7091a85, e3983ff; console `main` ad35921; backend `hardening/pilot-readiness` this status update.
    Working trees clean except the owner's untracked `docs/UNIFIEDAI_ARCHITECTURE_GUIDE.md` (left untouched).
- 2026-10-13: owner decisions carried out (details: frontend `docs/EDUAMIGO_WEB_UX_AUDIT.md`, "Owner decisions").
  - Date of admission: new optional `Student.admittedOn` (null = not recorded; never taken from createdAt). It is set
    by the add/edit forms, a bulk upload column, or Admissions "admit". It must be a valid past date, not before
    birth. The transfer certificate returns it as recorded plus a `missing` list, and the screen prints "Not
    recorded" and asks for the real date.
  - Migration `npm run migrate:admission-dates`: dry run by default; `--apply` fills only students admitted through
    Admissions, from the "Admitted" step's day. It was **run only in tests, not on any real database**; production
    needs the owner's approval and a backup first.
  - Back/Forward: guarded without changing the router. useBlocker needs a data router (checked in React Router
    7.18.4). A popstate listener added before BrowserRouter stops the move, restores the address, asks, and repeats
    the move on Leave. Verified in Chrome. A data-router migration is not needed and is not planned.
  - Admin menu keyboard access: links and buttons, focus kept after moving, visible ring, skip link, phone menu as a
    dialog.
  - Printing: Chrome verified. Safari 26.5.2 is installed but automation is off (its "Allow remote automation"
    setting, not changed), so it is not verified. Firefox is not installed, so it is not verified. A grey band under
    printed documents was found in Chrome and fixed.
  - Also fixed: the student edit form's date of birth was never shown or saved (wrong field key); the certificate
    overflowed phones.
  - Results: backend 733/733; frontend Playwright 42/42; unsaved-changes tests 32/32 over 4 repeats; sweep 150
    screenshots, 0 JS errors, 0 sideways scroll; builds ok; 0 lint messages on changed lines.
  - Local commits (not pushed): backend 6ea4038 (+ this update); frontend 16f3531, 3ff48d3, 7ed0f18, 7cae7d3,
    86983f4. Console unchanged since ad35921.
- 2026-10-14: EduAmigo AI. Details, measurements and limits are in `docs/EDUAMIGO_LEARNING_AI.md`.
  - Root cause of study requests turning into tickets: the understanding prompt filed "a doubt about a lesson" under
    `forward` (a ticket for the teacher), and there was no study topic. Fixed with a `learning` topic and a `learn` kind,
    with the server overruling a model `forward` that has no pass-on words. Explicit "teacher ko bolo..." still makes a
    ticket. A records failure in Ask is now reported as a failure for that part, never as "nothing found".
  - Learning AI for students (`/student/learn` replaces "Revise with AI"):
    - AI Tutor and Guided Learning, streamed: school notes searched (vector on Atlas, BM25 elsewhere) and cited.
    - Calculations re-computed by a safe parser; validated diagrams.
    - Evidence-based reliability notes (no percentages); history with delete and a 180-day limit.
    - Voice Learning with the browser's speech services.
    - Practice & Assessment with checked answer keys and fair marking.
    - Revision Planner from real exam dates; Learning Progress.
  - Web research is not built: no search provider is configured (needs approval).
  - Results:
    - backend 773/773; frontend Playwright 55/55; sweep 150 screenshots, 0 JS errors, 0 sideways scroll.
    - Live latency (12 tutor answers): first token p50 0.93 s, p95 3.6 s; Ask understanding p50 1.5 s.
    - Voice latency is recorded in the app but not yet measured on a real device.
  - Local commits (not pushed): backend 47e82ab, 9823698, 80ec694 (+ docs); frontend f5f5cfe (+ docs).

- 2026-10-14 AI Learning Assistant completion, voice and usage-based cost control (local only, not pushed). Details:
  `docs/EDUAMIGO_LEARNING_AI.md` sections 13 and 14.
  - Why tests said "no AI provider": the test servers run with `ASSISTANT_AI=off` (switched off, not unconfigured). The
    messages now say which it is; the Learning screen shows a banner.
  - Built: intent and follow-up handling, language mirroring, graphs/concept maps/cycles drawn from validated data,
    TEACH to PRACTICE to EVALUATE to REVISE (difficulty and re-teach only on enough evidence), per-call usage ledger,
    per-school token/budget/feature limits with warning and hard stop, one answer at a time per person, admin usage
    page and API.
  - Real provider smoke test (Azure gpt-4.1-mini, isolated backend): English, simpler follow-up, maths, graph, cycle,
    practice and a provider failure worked; the first run found "I cannot draw" for a diagram request and a wrong
    "no notes uploaded" message, both fixed.
  - Tests: backend 804/804; frontend 68/68 (own ports 8110/5184).
  - Local commits (not pushed): backend 90d6b6b, 1340dbb, 415735f, 856090c; frontend d5fe97e, 7e3ee69, 15a0310.
- 2026-10-15 AI network reliability. The intermittent "could not answer just now" was the Mac's ISP DNS resolver timing out (public
  resolvers and TCP/TLS/HTTPS were fine; the key and deployment work). Added failure classification, bounded retries with a time budget,
  reason-specific student messages, and `npm run diagnose:ai`. Backend 842/842, frontend 76/76. Details: `docs/EDUAMIGO_LEARNING_AI.md` section 15.

## Known gaps (honest list)
- Most internal screens still use their original inline styles and colours (e.g. green/orange page headers on Students and
  Fees); they are responsive but not yet visually unified with the dashboards. Example: on the teacher's leave screen
  the "Total" balance number is teal on a teal card and hard to read.
  (Fixed 2026-10-13, frontend 837b4d7: the 48 icon-only back, send and close buttons that showed ← ➤ × now use line
  icons and all have screen-reader labels.)
- (Fixed 2026-10-13, frontend 2ab6301: the student results page now uses the shared tab bar with Learn current.)
- Unsaved changes: Back/Forward guard verified in Chrome only. Session expiry on a dirty form: the browser asks, but
  the session is already cleared.
- Date of admission: existing and imported students show "Not recorded" until the school enters the real date; the
  migration has not been run on real data.
- Printing verified in Chrome only (Safari not automated, Firefox not installed).
- AI:
  - Voice not tried with real speech or on phones (only a scripted stand-in and a real-AI run with it).
  - Cost: `AI_PRICING` is not set anywhere, so cost shows "not priced" and a cost budget cannot be enforced; the
    provider's real invoice is not read. Provider-side spend limits are a separate setting for the owner.
  - No stronger-model routing (one model is configured), no provider-billed voice, no image or graph upload.
  - "Revise my notes" checked with real provider only without notes; with real notes it is mocked-tested.
  - No labelled accuracy set for study answers.
  - Web research not built.
  - Notes have no page numbers.
  - The wider Ask upgrade (comparisons, trends and follow-ups across all modules) is not done.
- Push: the backend sends through Firebase; the apps need the Firebase files and an APNs key (owner's accounts). Not
  verified on a phone yet.
- iOS links (`eduamigo://`): iOS asks "Open in EduAmigo?"; the scheme is verified, tapping Open is a manual check.
- On the website the session token is in localStorage and there is no Content-Security-Policy yet.
- Exams, marks, report cards, timetable, transport, library, admissions, HR, notes and AI are verified by backend tests
  only, not end to end through the screens.
- Not done: physical phones, signed release builds, store listings and review, deployment (paused until authorised).

## Next actions (resume here)
1. Owner checks: print a receipt, a report card and a certificate in Safari (or turn on Safari ▸ Settings ▸ Developer ▸
   "Allow remote automation" if it should be automated); approve running `migrate:admission-dates` on real data when
   ready (after a backup).
2. Learning AI pilot on the local demo with real uploaded notes, a teacher and a few students; voice on a real Android
   phone and iPhone; set `AI_PRICING` and provider spend limits before any school is given a cost budget; a labelled
   study-question evaluation set. Approval needed for a web search provider, a stronger model or provider-billed voice.
3. W6: end-to-end tests for exams to report card, timetable, transport, library and admissions.
4. Security: Content-Security-Policy and the web token storage decision.
5. W9: final handover document.
