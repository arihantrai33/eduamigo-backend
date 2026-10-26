# Load test report — local, staged

**Status: Stages A to F (10 to 1,000 simulated users) passed on this MacBook; the sign-in bottleneck seen at Stage F has been fixed and Stage F re-run (see the update below). Stages G, H and I (2,500 / 5,000 / 10,000) have not been run. EduAmigo has not been shown to support 10,000 concurrent users.**

Machine: 10 CPUs, 16 GB RAM. Harness: `loadtests/stage.js` (see `loadtests/README.md`). Database: a throwaway in-memory MongoDB on the same machine. Runs on 2026-10-25.

## Update: live bus tracking and 2,850 to 5,700 people at once (26 October)

Full write-up: `EduAmigo_Technical_Bus_And_Mixed_Load_Report.pdf` (and the plain-language `..._Pehle_vs_Ab_...pdf`). Tools: `loadtests/bus-check.js`, `loadtests/mixed-check.js`, `loadtests/k6/mixed.js`, `loadtests/fake-ai.js`.

- Bus position error p95 12.4 m, phone to screen p95 7 ms, 895 attempts to see another bus or school: 0 succeeded; parent messages correct for 72 of 72 parents.
- Mixed activity (bus maps, chat, AI tutor with a stand-in provider, ordinary screens, 30 to 60 schools): 2,850 people reads p95 5 ms, 4,275 p95 6 ms, 5,700 p95 27 ms; 0 errors in all; one server used 42 % of a core at 2,850.
- Four problems found and fixed: driver batches counted per network address (429s), poor GPS moving the bus up to 64 m, a school's wifi refused after about 100 sign-ins a minute (anonymous limit 120 to 1,500 per minute per address), and bus tracking not working on more than one server (state now follows the database). Backend suite after: 71 files, 1,307 tests.
- This corrects the advice above to "add a second instance": that is safe for bus tracking only from this change on.

## Update: fee payments and chat added, Stages B to F repeated (26 October)

The journeys now also include chat (inbox, unread count, parents messaging the class teacher and reading the thread) and the office recording fee payments, on purpose on only 3 fees per school so several payments land on the same fee at the same time.

| Stage | Users | Requests | p95 / p99 / slowest (ms) | Errors | Fee payment p95 | Event-loop windows over 100 ms | Data checks | Verdict |
|---|---|---|---|---|---|---|---|---|
| B | 50 | 4,732 | 8 / 64 / 103 | 0 | 11 ms | 0 | pass | PASS |
| C | 100 | 15,365 | 7 / 12 / 106 | 0 | 10 ms | 0 | pass | PASS |
| D | 250 | 38,420 | 7 / 11 / 149 | 0 | 8 ms | 0 | pass | PASS |
| E | 500 | 76,828 | 6 / 12 / 249 | 0 | 7 ms | 0 | pass | PASS |
| F (first run) | 1,000 | 152,217 | 53 / 632 / 4,387 | 0 | 717 ms | 3 of 214 | pass | PASS, noisy |
| F (second run) | 1,000 | 153,336 | 28 / 125 / 1,352 | 0 | 52 ms | 0 of 214 | pass | PASS |

- **Money and messages stayed correct under concurrency:** about 250 payments on the same three fees at Stage F, and about 800 chat messages; `verify.js` found no duplicate receipt numbers, no fee over-paid, totals equal to the sum of payments, and no message repeated. No cross-school response in any stage.
- **Why two Stage F runs:** the first run had stalls of up to 4.4 s across *all* endpoints at once (reads too), while the application's CPU dropped to 10 % at that moment and the event loop was never blocked for more than 261 ms. That is the load generator, not the server, being held up: at that time the Mac was using 8.8 of 10 GB of swap, and k6 held 3.4 GB. After closing my own leftover test servers the second run showed a worst case of 1.35 s and fee payments at 52 ms. Both runs meet the targets; the worst-case tail varies between runs on this machine, so do not quote one number.
- **Still not run:** Stage G and above. The load generator needs about 3.4 to 4.4 GB at 1,000 users, so a separate machine is needed beyond that.

### Production-mode and staging checks
- The API run as in production (`NODE_ENV=production`, strict CORS, production rate limits, error masking; `loadtests/prod-mode.js`) with the production build of the website served from another address, crawled page by page (70 pages x 2 widths): no console errors or failed calls other than the valid "no bus assigned" and "no timetable" answers. A website origin that is not allowed is refused.
- Security audit of production dependencies: the two high findings (multer, body-parser; denial of service) were fixed by patch updates (backend suite re-run: 67 files, 1,294 tests passed). Seven moderate findings remain, all in the `firebase-admin` chain (the fix is a major upgrade).
- A real staging service now exists: `eduamigo-staging` on Render (branch `staging`, separate database `eduamigo_staging` on the same cluster, no AI, e-mail, SMS, payment or storage keys). Read-only smoke check against it: 10 of 10 passed. The migration was rehearsed on its database: applied once (200 fee statuses, 200 enrolments, 10 teaching assignments) and a second dry run showed nothing left to change.

## Update: the sign-in bottleneck at 1,000 users, diagnosed and fixed

### Root cause (measured)
Passwords were checked with `bcryptjs`, the pure-JavaScript bcrypt, on the same single thread that answers every request.
1. **Micro-measurement** (same hash, cost 10, 17 sign-ins per second for 10 s, as in Stage F's ramp): with `bcryptjs` the event loop was late by 58 ms at p99 and ordinary work ran 53 ms late; with native `bcrypt` the delay was 6 ms and ordinary work 1 ms late. One check costs about 50 ms of CPU in both, the difference is *where* it runs.
2. **On the real server** (new `loadtests/lagprobe.js`, which records event-loop delay every 2 s): before the fix 21 of 211 two-second windows had a p99 loop delay over 100 ms (worst 174 ms), the process sat near 100 % of one core while the machine was 11 to 17 % busy, and sign-in p95 was 3.7 s. 17 sign-ins a second at 50 ms each is about 85 % of one thread, so every request queued behind them.
3. MongoDB was not the cause: no operation over 100 ms, 82 to 87 connections of a pool of 100 (fewer after the fix, because requests no longer pile up).

### Changes
- `src/services/passwordHash.js` (new): uses native `bcrypt` (hashing on libuv worker threads); falls back to `bcryptjs` with one warning if the native module cannot load. Both write and read the standard `$2b$` format, so **all existing hashes keep working; nothing is rehashed or reset; the cost stays 10**.
- `src/models/User.js` and `src/services/credentials.js` use it. Behaviour of sign-in, password change and reset is otherwise unchanged.
- `package.json` / `package-lock.json`: added `bcrypt@^6.0.0` (and its two small helpers `node-addon-api`, `node-gyp-build`). `bcryptjs` stays, as the fallback. Prebuilt binaries are included for macOS, Linux (x64, arm64) and Windows, so no compiler is needed; npm printed a notice about install scripts, which is harmless because the prebuilt binary loads (checked on this Mac: Node v26, arm64).
- **Sign-in concurrency limit** (also in `passwordHash.js`): at most (worker threads - 1) = 3 password checks at once; extra ones wait in memory; if 300 are already waiting the next sign-in is refused with a plain `503 "Sign-in is very busy right now. Please try again in a few seconds."` (never a 401). Settings: `PASSWORD_CHECK_CONCURRENCY`, `PASSWORD_CHECK_QUEUE`.
  Why: the worker threads are shared with file reads and DNS lookups in one first-in-first-out line. Measured in process with 250 sign-ins queued at once: an unlimited native bcrypt made a file read wait **3.4 s**; with the limit the worst file read took **under 1 ms**. The price is that a pure sign-in flood is served about 30 % slower (250 sign-ins in 4.6 s instead of 3.5 s).
- Harness only: `loadtests/lagprobe.js`, an event-loop-lag section and sign-in p95/p99 in the stage output.

Not done, on purpose: no multiple instances, no worker pool of our own (not needed once the work leaves the request thread), no lower cost, no rehash, no change to who can sign in or to the sign-in and reset rate limits.

### Regression
- New: `tests/password-hash.test.js` (9 tests): hashes written by `bcryptjs` at cost 10 and 12 verify with the new code, and a wrong password is refused; new hashes are standard bcrypt and `bcryptjs` can still check them; production cost is still 10; other work keeps running during a check (3 timer ticks with `bcryptjs`, 18 with native in the same test); the fallback works if the native module is missing; the concurrency limit, the 503 and recovery. `tests/login-busy.test.js`: over HTTP a flooded sign-in gets 503 with its own message and code, nothing is let in, and the line recovers.
- Full backend suite: **67 suites, 1,294 tests passed** (was 65 / 1,284; the other new tests are these).
- Frontend end-to-end sign-in and navigation: `auth.spec.js` (37), `auth-and-navigation.spec.js` and `workflows.spec.js` (13 together): all passed against the backend with the new code. The complete 336-test frontend run was not repeated.

### Before and after: Stage F, same workload
Same seed (30 schools x 100 students), 1,000 users, ramp 60 s, hold 5 min, mix 40/25/20/15, same MacBook. The first column is the baseline reported above.

| | Original baseline | Re-run, before the fix | After the fix | After the fix + limit (final) |
|---|---|---|---|---|
| Run | F-20261025T1156 | F-20261025T1228 | F-20261025T1241 | F-20261025T1255 |
| Throughput (requests/s) | 299 | 301 | 304 | 304 |
| Sign-in p95 / p99 | 4,139 / 4,248 ms | 3,724 / 3,935 ms | 65 / 122 ms | **63 / 72 ms** |
| Overall p50 / p90 | 2 / 13 ms | 2 / 12 ms | 1 / 6 ms | 1 / 5 ms |
| Overall p95 | 164 ms | 156 ms | 8 ms | **7 ms** |
| Overall p99 | 525 ms | 443 ms | 52 ms | **28 ms** |
| Slowest request | 4,335 ms | 4,019 ms | 496 ms | 324 ms |
| HTTP errors / 5xx | 0.003 % (4 requests) | 0 | 0 | 0 |
| Event loop: windows with p99 over 100 ms | not measured | 21 of 211 | 0 of 212 | 0 of 212 |
| Event loop: worst p99 / worst single delay | not measured | 174 / 174 ms | 30 / 361 ms | 29 / 120 ms |
| App CPU average / peak | 43 / 117 % | 41 / 113 % | 41 / 129 % | 41 / 127 % |
| MongoDB connections (peak) | 82 | 87 | 48 | 44 |
| Cross-school responses | 0 | 0 | 0 | 0 |
| `verify.js` / `isolation-check.js` | pass / pass | pass / pass | pass / pass | pass / pass |

Reading it: the same traffic is served with the same total CPU (about 41 % average; the work moved off the request thread, it did not disappear), and the slowdowns are gone. The peak above 100 % is now several threads, not one saturated thread. Throughput is the same because the workload is fixed by think time, not by what the server can do, so it is not evidence of higher capacity.

### What remains
- One 361 ms event-loop pause appeared in one of the two post-fix runs (at 44 s, once, with the 2-second p99 at 20 ms) and a 120 ms one in the other; the cause was not identified (garbage collection or a heavy request are possible). It was not seen in any of the 21 bad windows before the fix, but a single pause is not enough to call it a problem or to rule it out.
- Hashing is still CPU work: a sustained sign-in rate above about 60 per second per process (3 threads at 50 ms) will queue. That is far above the 17 per second of this burst, but it is the next ceiling for one instance, and the answer there is more instances, with the sign-in limit and rate-limit counters already shared through MongoDB.
- Setting passwords (`hashPassword`: new users, resets) is not limited by the concurrency cap, on purpose, so a bulk import cannot be refused with a 503.
- The 503 is logged as an error by the central handler; during a real flood that is many log lines.
- Stage F is still the highest stage run. Stages G, H and I were **not** run, as asked. The other limits listed in sections 5 and 7 below still apply (in-memory database on the same machine, missing journeys for fees, chat and bus pings, load generator memory).

---

The sections below are the original report (before the fix).

## 1. Successfully tested concurrency
Up to **1,000 simulated users** (Stage F), all reached, with no errors, no 5xx, no cross-school data, and `verify.js` and `isolation-check.js` passing after every stage.

| Stage | Users | Hold | Requests | p50 / p95 / p99 / max (ms) | HTTP errors / 5xx | App CPU peak | Mongo CPU peak | k6 memory peak | Verdict |
|---|---|---|---|---|---|---|---|---|---|
| A | 10 (reached 10) | 2m | 555 (3/s) | 4 / 13 / 74 / 108 | 0.00 % / 0.00 % | 16 % | 5 % | 60 MB | **PASS** |
| B | 50 (reached 50) | 3m | 3,893 (15/s) | 3 / 9 / 73 / 102 | 0.00 % / 0.00 % | 28 % | 8 % | 129 MB | **PASS** |
| C | 100 (reached 100) | 5m | 12,520 (31/s) | 3 / 8 / 52 / 108 | 0.00 % / 0.00 % | 29 % | 9 % | 220 MB | **PASS** |
| D | 250 (reached 250) | 5m | 31,325 (76/s) | 2 / 8 / 59 / 133 | 0.00 % / 0.00 % | 50 % | 11 % | 935 MB | **PASS** |
| E | 500 (reached 500) | 5m | 62,634 (153/s) | 2 / 8 / 55 / 129 | 0.00 % / 0.00 % | 100 % | 17 % | 2725 MB | **PASS** |
| F | 1000 (reached 1000) | 5m | 123,649 (299/s) | 2 / 164 / 525 / 4335 | 0.00 % / 0.00 % | 117 % | 44 % | 3431 MB | **PASS** |

Mix: 40 % student, 25 % parent, 20 % teacher, 15 % office; 2 to 6 s think time; each user signs in once. Targets: p95 <= 500 ms, p99 <= 1,000 ms, errors < 1 %.

## 2. Highest stable concurrency
**1,000 simulated users, with a caveat.** Stage F met every threshold, but its worst-case latencies are not healthy (section 4). I would call 500 users clean and 1,000 users passing-with-a-warning on this setup. These are figures for this laptop and an in-memory database, not for production.

## 3. First stage that failed
None of A to F failed. (Stage B once reported a "cross-school response"; it was a false alarm in the test, explained in section 6.)

## 4. What Stage F showed (the first sign of a limit)
Whole-run p95 was 164 ms and p99 525 ms, but the maximum was **4.3 s**, and the slow tail is concentrated in the first minute, while the 1,000 users were signing in:

| Endpoint (Stage F, slowest p99 first) | Requests | p95 ms | p99 ms | max ms |
|---|---|---|---|---|
| login | 1,032 | 4139 | 4248 | 4335 |
| office: dashboard | 2,589 | 287 | 3513 | 4219 |
| parent: attendance | 5,284 | 249 | 3468 | 4172 |
| teacher: profile | 4,285 | 277 | 3368 | 4215 |
| student: profile | 5,816 | 173 | 3044 | 4202 |
| teacher: save attendance | 894 | 389 | 551 | 726 |
| parent: children | 250 | 336 | 395 | 2090 |
| parent: fees | 5,284 | 213 | 344 | 3685 |
| parent: homework | 5,284 | 199 | 333 | 2501 |
| office: fees | 2,589 | 211 | 327 | 3226 |

Evidence from the samples taken every 2 seconds (`results/F-20261025T1156/samples.json`):
- For about 65 seconds (the ramp, while users sign in) the application process sat at **about 100 % of one CPU core**, while the machine as a whole was only 17 % busy and MongoDB was at 2 to 10 %.
- Sign-in p95 was **4.1 s**, and during the same window ordinary reads (dashboard, profile, attendance) also had p99 of 3 to 3.5 s. After the sign-ins finished, application CPU fell to 30 to 40 % and latency returned to a few milliseconds.
- Passwords are checked with `bcryptjs` (`src/services/credentials.js`), the pure-JavaScript version, at cost 10. It runs on the same single thread that answers every request, so a wave of sign-ins delays everyone.

Conclusion: the first bottleneck is **the single Node.js process, saturated by sign-in hashing**, not MongoDB (no slow operations over 100 ms were recorded, 82 peak connections of the default pool of 100) and not the load generator (k6 CPU 21 % average; host 17 %).

Smallest evidence-backed options (nothing was changed; each touches sign-in, so I need your approval first):
1. Replace `bcryptjs` with the native `bcrypt` package, which hashes on worker threads and does not block the request thread. Existing hashes stay valid. Needs a regression test for sign-in and password change.
2. Or run two or more application instances behind the host's load balancer (a deployment change, no code change). The sign-in limit and rate-limit counters are already shared through MongoDB.

Either should be tried and Stage F repeated before going higher. One caution: 1,000 users signing in within 60 seconds is a hard burst (about 17 sign-ins per second). Sessions last 24 hours, so in real life most users do not sign in at the same moment; but a school opening-hour rush is plausible and is the case to plan for.

## 5. MongoDB and load-generator notes
- MongoDB: CPU peak 44 %, memory 142 MB, connections peak 82 (driver default pool is 100, so headroom is shrinking: 28 at 10 users, 39 at 500, 82 at 1,000). No operation over 100 ms in any stage.
- This is an in-memory database on the same machine with 100 students per school. A real database over a network, with a larger dataset, will be slower. These numbers say nothing about Atlas or any hosted tier.
- Load generator: k6 used 3431 MB of memory at 1,000 users (it grows roughly 3.4 MB per user). 2,500 users would need about 8.5 GB, 5,000 about 17 GB (more than this Mac has), and 10,000 about 34 GB. **Stages H and I cannot be run on this Mac**; they need a separate machine or distributed load generation. Stage G is borderline for memory and would need other apps closed.
- Available memory fell to 2.5 GB during Stage F. The runner stops the stage below 1.5 GB.

## 6. Fixes made
No application code was changed. Test-harness changes:
- Role assignment now spreads the 40/25/20/15 mix evenly (the first Stage A run used only students and gave a false PASS).
- Stage B reported 1 cross-school response. Investigation (the probe now logs the address and answer) showed `GET /api/fees/<student of another school>` returns 200 with `data: []` and totals of 0: the school filter hides everything, so no other-school data was exposed, but a 404 would be cleaner. The probe now counts a response as a leak only when it carries records. Stage B was rerun and then B to F were run in full on the corrected harness.
- During this work a separate real bug was found and fixed outside the load test: `/admin/homework` called `/api/teachers/me`, which refuses the office (403). It now skips that call for the office view.

## 7. Untested scenarios and limits
- Stages G, H, I. G needs your approval (`--confirm-high`); H and I need a separate load-generator machine (section 5).
- Not in the journeys yet: fee payments, fee-record creation, chat with attachments, concerns, profile photo upload, bus GPS pings (`/transport`) and the live-bus views, reports, year-end, the AI features. Bus pings are likely to be the heaviest write load in a real school; add them before trusting any capacity number.
- The general per-address rate limits were raised on the test server (one generator is one address); sign-in limits were left at production values.
- Only one application instance was tested.
- Think time is 2 to 6 s. Real use is burstier at school start and end.

## 8. Were 10,000 concurrent users reached and sustained?
**No.** The highest reached and sustained was 1,000 simulated users, on a laptop, with an in-memory database.

## Next safe action
Pick one:
- (a) Fix the sign-in bottleneck (option 1 or 2 in section 4), then repeat Stage F and compare. This is what I recommend before going higher.
- (b) Add the missing journeys (fees, chat, bus pings) and rerun B to F.
- (c) Run Stage G (2,500 users) with `node loadtests/stage.js --stage G --confirm-high` after closing other apps. It needs your explicit approval.
