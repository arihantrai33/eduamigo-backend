# Load tests

Repeatable tests for the pilot scenario: 3 schools, about 1,000 students each. They use **synthetic data only** and refuse to touch a
database whose name does not end in `_loadtest` or `_staging`. Never point them at production.

## What is here
| File | Purpose |
|---|---|
| `seed.js` | Creates 3 schools, ~1,000 students each, parents, teachers, fees, academic sessions (writes `data/seed.json`, git-ignored) |
| `k6/attendance.js` | Morning rush: every teacher saves their classes twice within a window |
| `k6/login-burst.js` | Parents signing in in a burst |
| `k6/feeday.js` | Payments recorded while parents view their fees |
| `k6/yearend.js` | Year-end for one school (about 1,000 students), run twice |
| `k6/ask.js` | EduAmigo Ask with many users (needs an AI provider on the server) |
| `k6/soak.js` | Steady mixed traffic for a long time |
| `verify.js` | After the run: duplicate receipts, fee totals, attendance rows, repeated messages, roll numbers, orphan logins |
| `isolation-check.js` | Over HTTP: each school asks for the others' records by id; nothing may come back |
| `local.js` | Smoke run on this machine (in-memory database). **Not** a capacity test |

## Staged local test (A to I) — `stage.js`
One command runs one stage end to end on this machine, with a **throwaway in-memory MongoDB** (database `stage<x>_loadtest`), synthetic
schools, the API on port 8101 and k6. It never reads `MONGO_URI` from `.env`, blanks every external-service key (AI, Cloudinary, Razorpay,
e-mail goes to the log), and refuses anything that is not a local `_loadtest` database. It runs **one** stage and stops.

```
node loadtests/stage.js --stage A                      # default: 10 users, 2 min
node loadtests/stage.js --stage B                      # 50 users, 3 min
node loadtests/stage.js --stage C|D|E|F                # 100 / 250 / 500 / 1,000 users, 5 min each
node loadtests/stage.js --stage G --confirm-high       # 2,500 users   (needs your explicit approval)
node loadtests/stage.js --stage H --confirm-high       # 5,000 users
node loadtests/stage.js --stage I --confirm-high       # 10,000 users, only if results/latest-H.json says PASS
node loadtests/stage.js --stage C --hold 1m --ramp 20s   # shorter, while developing
```
Stages are in `stages.json`. Traffic is 40 % student, 25 % parent, 20 % teacher, 15 % office (`--mix student:40,parent:25,teacher:20,admin:15`);
each user signs in once and repeats the role's journey (`k6/journeys.js`, only endpoints the website calls) with 2-6 s think time.

What it records in `results/<run>/` (git-ignored): `result.json` (verdict and all figures), `samples.json` (CPU / memory / MongoDB every 2 s),
`k6-summary.json`, `k6.log`, `server.log`, `verify.log`, `isolation.log`, `created.json` (ids of records the test created).

**Verdict** is PASS only when: p95 <= 500 ms, p99 <= 1,000 ms, errors < 1 %, 5xx < 5 %, checks > 99 %, no cross-school response, 95 % of the users
were reached, `verify.js` and `isolation-check.js` pass, the app answers after the run. If a threshold is missed while the host is saturated
(CPU >= 85 % during the hold) the verdict is **INCONCLUSIVE**: the load generator, not the application, may be the limit.

**Stops by itself** on: 5xx above 5 % for 30 s, any cross-school 200, host memory below 1.5 GB twice in a row, the app or MongoDB process stopping.

**Deliberate deviations from production** (say so in every report): the general per-address limits (`API_ANON_PER_MINUTE`, `API_USER_PER_MINUTE`) are raised
on the test server because one generator is one address; the sign-in limits stay at production values, so no account is shared by more than 5 users
(the runner seeds more schools for bigger stages). Passwords use the production cost (bcrypt 10). The database is a single in-memory MongoDB on the
same machine, so figures show the application's relative bottlenecks, not what a real database tier will do.

`results/<run>/eventloop.json` (from `lagprobe.js`) holds the event-loop delay every 2 s; the stage output reports the worst window and how many windows had a p99 over 100 ms.

**Cleanup.** After a normal run there is nothing to clean: the database disappears. For a persistent local test database:
`MONGO_URI=.../x_loadtest node loadtests/cleanup.js --run <run>` lists what it would delete; add `--confirm` to delete. It deletes only the ids in
that run's `created.json`, only in a database named `_loadtest` / `_staging`, and only if the title still carries the run's `LOADTEST <run>` mark.

## Run on staging
1. Use an **empty** database named `..._staging` or `..._loadtest` and a server connected to it (see `docs/STAGING_PLAN.md`).
2. Seed: `LOADTEST_SEED_OK=yes MONGO_URI="<staging uri>" node loadtests/seed.js` (about 3,000 students; `--students 1000 --schools 3` are the defaults).
3. A single load generator looks like one visitor, so raise the general limits on the **staging server only**, for the test:
   `API_ANON_PER_MINUTE=1000000 API_USER_PER_MINUTE=1000000` (the login limits stay on, which is why every script uses its own set of accounts).
4. Install k6 (`brew install k6`), then `export BASE_URL=https://<staging api>` and run the scripts below. Wait 15 minutes between runs that reuse
   the same accounts, or set `SESSION_OFFSET`, because logins are limited to 10 per 15 minutes per account.
5. After each run: `MONGO_URI="<staging uri>" node loadtests/verify.js`. Then `BASE_URL=... node loadtests/isolation-check.js`.
6. Watch the server and database while it runs (see "What to record").

The year-end script deactivates the accounts of the highest class (that is what year-end does), so run it last or re-seed afterwards.

## Acceptance criteria (targets agreed in the audit; none has been measured on a real environment yet)
| Test | Load | Pass when |
|---|---|---|
| `attendance.js` | 3 schools x about 40 teachers within 10 min (`WINDOW_SECONDS=600`) | p95 < 1.5 s, 0 server errors, one row per student, no repeated parent message (`verify.js`) |
| `login-burst.js` | 1,500 logins in 5 min (`LOGINS_PER_SECOND=5`, `DURATION=5m`) | p95 < 1 s, errors < 1 % |
| `feeday.js` | 300 payments/hour and 600 fee views/hour (defaults), 1 h (`DURATION=1h`) | p95 < 1.5 s, 0 duplicate receipt numbers, totals add up (`verify.js`) |
| `yearend.js` | one school, ~1,000 students | no timeout, under 2 min, the repeat changes nothing |
| `ask.js` | 100 users for 5 min | p95 < 6 s, errors < 1 %, still answers when the model is slow or down |
| `soak.js` | `DURATION=24h` | p95 < 1.5 s throughout, errors < 1 %, memory and database connections flat |
| `isolation-check.js` | after seeding | 0 cross-school responses |

## What to record with every run
Date, commit, server plan and size, database tier and region, `k6` summary (p50/p95/p99, error rate, requests per second), server CPU and
memory, database CPU / connections / operations per second, slow queries, and the output of `verify.js`. A result without these is not evidence.

## About the smoke run
`node loadtests/local.js` runs everything against an in-memory database on one machine, with AI keys blanked. It proves the scripts work
and the data checks pass; its timings say nothing about production.
