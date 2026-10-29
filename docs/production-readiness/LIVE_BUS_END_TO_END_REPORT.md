# Live bus tracking: end-to-end hardening report (27 October 2026)

**Verdict: READY FOR STAGING. NOT READY FOR PRODUCTION** (reasons in section 9). Nothing here has been committed, pushed or deployed.

## 1. Root causes found in the existing flow
| # | Finding | Evidence |
|---|---|---|
| 1 | An open live map was authorised once, when it was opened. Removing a student from the bus, disabling the account, signing out everywhere or suspending the school did not end the stream. | New tests: the stream stayed open (re-check silently failed because of the tenant guard until fixed). |
| 2 | Start Trip on a running trip reset the stops, issued a new trip and told every parent "the bus has started" again. | Test: before, second start answered 200 and re-notified. |
| 3 | Two phones with one driver code could both feed the same trip (conflicting positions). | By construction: no phone identity existed. |
| 4 | Bus state lived only in each server's memory: with two servers, half the driver's batches were refused (409) and viewers missed half the updates. | 187 of 373 batches refused, 558 of 1,116 updates missing (loadtests/bus-check.js, two servers). |
| 5 | Driver requests were rate-limited per network address (120/min); buses sharing a carrier or depot address blocked each other. | 47 of 743 batches got 429. |
| 6 | Poor GPS (60 to 140 m) moved the bus up to 64 m. | bus-check: median 33 m, max 64 m. |
| 7 | School wifi: after about 100 sign-ins a minute everyone was refused (anonymous limit 120/min per address). | Test `school-wifi-login`. |
| 8 | The bus icon never showed its heading; no reduced-motion handling; a late packet could move the bus backwards; a viewer who lost access kept retrying forever. | Code review of AnimatedBusMarker/liveBus. |
| 9 | A code comment said background tracking was available in the Android app. It is not: no background-location plugin is installed. | package.json, capacitor plugins. |

## 2. What changed
Backend: `src/routes/transportRoutes.js` (access re-check of open streams, one trip per bus, one phone per trip), `src/services/busTracking.js` (recheck events, accuracy-aware smoothing, state that follows the database across instances, trip phone), `src/models/Transport.js` (`driverDevice`), `src/middleware/rateLimit.js` + `src/app.js` (driver limits per code; school-wifi limits), `tests/bus-security.test.js`, `tests/bus-instances.test.js`, `tests/driver-*.test.js`, `tests/school-wifi-login.test.js`, `docs/LIVE_BUS_TRACKING.md`, `loadtests/bus-check.js`, `loadtests/mixed-check.js`.
Frontend: `src/pages/bus/motion.js` (new: heading wraparound, late packets, snap rules), `AnimatedBusMarker.jsx` (direction arrow, reduced motion, stale look), `liveBus.js` (stops on revoked/401/403/404), `BusTracker.jsx` (access-ended screen, stale marker, tile attribution setting), `src/pages/driver/*` and `src/api/transport.js` (phone id, takeover, honest background note), `src/index.css`, tests `e2e/bus-motion.spec.js`, `e2e/bus-access-ui.spec.js`, `e2e/bus-live.spec.js`.

## 3. Data flow (actual)
Phone GPS (1 s, queued on the phone) -> batch every 4 s `POST /api/transport/driver/:code/location` (validated, rate limited, phone checked) -> server snaps to the road (poor readings blended), follows the stops, computes ETAs, saves the latest position -> pushed on the bus's own channel -> `/live/:busId/stream` (NDJSON, ping every 15 s, access re-checked every 30 s and at once on assignment changes) -> the browser glides the marker (animation only in the browser).

## 4. Buses, routes, stops, trip states handled
Idle, On Route, Completed; pickup and drop (stops reversed); stops in order with Pending/Live/Departed; missing stops (409 "no stops"); deleted bus (stream ends); changed stops (state reloaded); abandoned trips (closed after 3 h, replaceable after 15 min of silence); readings after the trip ended (409). Stop arrival uses a distance plus route-progress rule per reading; messages are claimed atomically so a repeat never sends twice (72 of 72 parents correct).

## 5. Authorization evidence (server side)
`tests/bus-security.test.js` (14 tests): student and parent see only their own bus; parent with two children gets the child asked for and a forged/unrelated studentId opens nothing; another family, another school's student/parent/admin get 404/403; the office of one school cannot read, assign to or delete another school's buses; a driver code works for its own bus only; and while a map is open: a student removed from the bus, a child moved to another bus, a disabled account, a signed-out session, a suspended school and a deleted bus all end the stream. Load tests: 895 and 300 cross-bus attempts, 0 succeeded.

## 6. Driver workflow
Driver page signs in with a per-bus secret code (no accounts; unchanged by design). It shows GPS state, accuracy, queue and network, keeps the screen on, resumes a running trip after a reload, refuses a second Start, asks before taking a trip over from another phone, and stops (with a message) when another phone takes over. **Background tracking is not supported**: foreground only. This is stated in the app and docs.

## 7. Tests run (exact)
- Backend: 72 files, **1,321 tests passed**.
- Frontend end-to-end (real demo backend): bus specs, motion and access specs, new-features: **23 passed**; dashboards, parent dashboard, roles, layout alignment, workflows: **72 passed**.
- Build passes. Lint: no new errors; 3 errors already present in the previous commit remain in `BusTracker.jsx` and `Driver.jsx`.
- Load/accuracy (loadtests): bus check with two servers PASS (position error p95 12 m, delivery p95 0.87 s, 0 missing, 0 refused); mixed 2,850 people PASS (reads p95 6 ms, 0 errors).
- Honest cost of the new re-check: application CPU averaged 44 % (was 42 %), one 307 ms event-loop pause appeared.

## 8. Real versus simulated
**Not verified with real hardware:** real phone GPS, real moving vehicle, background/locked-phone behaviour, battery, iOS, Android native apps, real road routing, a paid map-tile provider, push notifications. Everything above used controlled readings (browser geolocation emulation, scripted drivers with noise, faults and a straight-line route), an in-memory database and a stand-in AI server.

## 9. Environment, costs, remaining blockers, rollback
Variables: backend `ROUTING_URL` / `MAPBOX_ACCESS_TOKEN` (server only), `BUS_*` and `DRIVER_*` settings (docs/LIVE_BUS_TRACKING.md); frontend `VITE_MAP_TILES`, `VITE_MAP_ATTRIBUTION`. Costs: a map-tile service and (optionally) Mapbox Directions are paid beyond free allowances: check current prices; the free OpenStreetMap tile server and the public OSRM server are not for production traffic.
Blockers before production: (1) a real-phone drive test on staging; (2) background location (plugin, Android foreground service, iOS "Always" permission, store review) or a decision to ship foreground-only; (3) replace the OSM tiles and public OSRM; (4) decide whether per-bus codes are acceptable or driver accounts are required; (5) run the staging smoke and a short bus check on the hosting.
Rollback: the changes are additive (one optional field `driverDevice`); redeploy the previous backend/frontend build (Render "roll back", Vercel "promote previous"); old driver apps keep working because a trip without a recorded phone accepts readings from any phone.
