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

## Known gaps (honest list)
- Most internal screens still use their original inline styles and colours (e.g. green/orange page headers on Students and
  Fees); they are responsive but not yet visually unified with the dashboards. Example: on the teacher's leave screen
  the "Total" balance number is teal on a teal card and hard to read.
  (Fixed 2026-10-13, frontend 837b4d7: the 48 icon-only back, send and close buttons that showed ← ➤ × now use line
  icons and all have screen-reader labels.)
- The student results page has its own tab bar (Home, Bus, Learn, Result, Me); every other student screen shows Home, Bus,
  Learn, Chat, Me. Unifying it changes a visible tab, so it waits for the owner's decision.
- Push: the backend sends through Firebase; the apps need the Firebase files and an APNs key (owner's accounts). Not
  verified on a phone yet.
- iOS links (`eduamigo://`): iOS asks "Open in EduAmigo?"; the scheme is verified, tapping Open is a manual check.
- On the website the session token is in localStorage and there is no Content-Security-Policy yet.
- Exams, marks, report cards, timetable, transport, library, admissions, HR, notes and AI are verified by backend tests
  only, not end to end through the screens.
- Not done: physical phones, signed release builds, store listings and review, deployment (paused until authorised).

## Next actions (resume here)
1. Owner decision: unify the student results tab bar (see Known gaps).
2. W4 (largely done 2026-10-13, see the web UX audit): owner decision on phone home headers scrolling away; table card
   layouts on phones; form validation review; remaining admin headers (Chat, ID cards, Ask, Teacher Profile, TC).
3. W6: end-to-end tests for exams to report card, timetable, transport, library and admissions.
4. Security: Content-Security-Policy and the web token storage decision.
5. W9: final handover document.
