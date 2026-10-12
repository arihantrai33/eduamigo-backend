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

Mobile toolchains on this Mac: Xcode 16.4 is installed; Java and the Android SDK are not (installable for free with Homebrew).

## Plan (dependency order)

| Step | Work | Status |
|---|---|---|
| W1 | Design tokens (`index.css`) and a shared navigation config per role | done (frontend 32dfbcd) |
| W2 | Portal shell: phone frame removed; sidebar from 1024 px, bottom navigation below; auth pages in a proper centred layout | done (32dfbcd) |
| W3 | Replace the duplicated bottom navs with one component (14 copies); widen phone-only containers and bars | done (32dfbcd) |
| W4 | Desktop layouts for the role dashboards (multi-column), then internal screens portal by portal | partly: home tiles 3 columns; internal screens fill the width; per-screen redesign pending |
| W5 | Admin: brand-consistent dashboard, server-side dashboard numbers, phone header, table overflow, chat on phones | done (frontend 19995f1, 0f1acbd; backend 6de4259) |
| W6 | Workflow verification per module (UI to API to database), fixes and tests | pending |
| W7 | Frontend test setup (Vitest + Testing Library) for navigation, auth guard and key flows; screenshot checks at 375/768/1024/1440 | pending |
| W8 | Mobile architecture decision (Capacitor vs React Native), then Android and iOS projects, push notifications, secure storage | pending |
| W9 | Final verification and handover | pending |

## Progress log
- 2026-10-13: audit done, plan written, frontend branch created.
- 2026-10-13: portals responsive (sidebar / bottom nav), one typeface (Inter, bundled), design tokens; admin dashboard
  redesigned on a new server endpoint `GET /api/schools/me/dashboard` (6 tests); teacher chat listed a parent of two
  children twice (fixed, test added); admin screens usable on phones via a scoped CSS safety net; admin chat one pane on phones.
- Screen sweep (automated, headless Chrome, in-memory demo data): 32 portal screens at 375 and 1280 px and 35 admin screens
  at 375 px. No JavaScript errors. Remaining horizontal overflow at 375 px: Ask Insights (45 px), ID card tool (fixed print size).
- Backend suite: 37 suites, 718 tests passing.

## Known gaps (honest list)
- Most internal screens still use their original inline styles and colours (e.g. green/orange page headers on Students and Fees);
  they are responsive now but not yet visually unified with the dashboard.
- No frontend automated tests yet (planned: Playwright end-to-end with the system Chrome, Vitest for units).
- Push notifications: the server stores device tokens but sends nothing.
