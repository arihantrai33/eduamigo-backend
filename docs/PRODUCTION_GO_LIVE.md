# Going live: from this code to real schools

Written 2026-10-25. It says what is already proven, what only the owner can do, and the exact order of steps.
Nothing in this file has been done on production yet.

## 1. Where things stand

| | State |
|---|---|
| Backend `eduamigo-backend` (Render, auto-deploys **main**) | Production, still on the 17 October version (`01b8f3f`). `main` has **not** been touched. |
| Backend staging | Render service `eduamigo-staging` (https://eduamigo-staging.onrender.com), deploys from the `staging` branch, database `eduamigo_staging` (same Atlas cluster as production, separate database). No AI, e-mail, SMS, payment or storage keys. Smoke check 10 of 10; migration rehearsed. |
| Website (Vercel) | Project `eduamigo-frontend`. `main` is production. The `staging` branch builds a Preview at https://eduamigo-frontend-git-staging-arihant-rai-s-projects.vercel.app whose `VITE_API_URL` points to the staging API (a branch-specific Preview variable). |
| Owner console | Committed locally, **no git remote**, so it cannot be deployed from this machine yet. |

Proven on one MacBook with a throwaway database (details: `docs/production-readiness/LOAD_TEST_REPORT.md`):
- 1,000 simulated users at once on one server instance, no errors, no data seen across schools; sign-in p95 63 ms after the bcrypt fix.
- 70 pages x 2 widths, with the production build of the website against the API in production mode (`NODE_ENV=production`, strict CORS, production rate limits): no console errors or failed calls other than the valid "no bus assigned" and "no timetable" answers.
- 1,294 backend tests, end-to-end tests for sign-in and the main workflows, 37 live checks across roles.
- `npm audit` for production dependencies: the two high findings (multer, body-parser: denial of service) were fixed; 7 moderate remain, all inside `firebase-admin` (the fix is a major upgrade, left alone on purpose).

Not proven: more than 1,000 users; a real hosted database; Safari, Firefox and real phones; push notifications, SMS, online payments and the AI features against the real providers.

### Demo link for showing EduAmigo to other people
- Website: **https://eduamigo-demo.vercel.app** (its own Vercel project `eduamigo-demo`, public, built from the `staging` code, talks to the staging API). The real project `eduamigo-frontend` and production are not involved.
- Data: the five demo schools of `npm run demo` (GVPS, SCS, LFS, AISGAYA, AISCHAKAND), loaded by `src/scripts/seedDemoData.js` into `eduamigo_staging` with a demo password chosen for this purpose (the platform-owner account gets a random password). Sign-ins: `admin@gvps.demo`, `teacher@gvps.demo`, student admission number `1`, parent mobile `9876543210`, school code GVPS.
- Re-seed: see the header of `seedDemoData.js`. It refuses any database not named `*_staging` or `*_demo`, and `--replace-test-schools` only drops a database whose schools are all load-test schools; to reset the demo itself, drop `eduamigo_staging` in Atlas first.
- Free Render instances sleep after about 15 minutes without traffic; the first request then takes up to a minute. Open the link a minute before a demo, or add a free uptime monitor on `https://eduamigo-staging.onrender.com/api/health` (every 5 minutes).
- Anything people do in the demo is saved in the staging database; reset by re-seeding.

## 2. Things only the owner can do
1. **Staging database user (recommended).** Staging currently uses the production Atlas user with a different database name (`eduamigo_staging`), because the Atlas CLI here is not logged in. Better: in Atlas create a separate user that can only use `eduamigo_staging` and replace `MONGO_URI` on the staging service, so a mistake can never write to production data.
2. **Secrets.** If `.env.save` or any credentials were ever shared or copied (`docs/DEPLOYMENT.md`, step 1), rotate the Atlas password, `JWT_SECRET` (everyone signs in again), and the Gemini and Cloudinary keys. Set every secret in the Render dashboard, never in git.
3. **Console hosting.** Say where the owner console should live; create a GitHub repository for it and add it as `origin`.
4. **Real providers.** SMS needs a provider and DLT registration; email uses a Gmail App Password or Brevo/Resend key entered in the console (Integrations). Payments need each school's Razorpay keys.
5. **Approve each production step in section 5.**

## 3. Environment variables (Render)
Required: `NODE_ENV=production`, `MONGO_URI`, `JWT_SECRET` (32+ characters), `CORS_ORIGINS` (the website address, comma separated; the server will not start in production without it).

Needed for the features to work in production:
| Variable | Why |
|---|---|
| `PUBLIC_API_URL` | The API's own https address; photo and file links are built from it. |
| `DATA_ENCRYPTION_KEY` | Encrypts each school's payment keys and the console's integration secrets. Generate once, keep it safe: losing it makes those secrets unreadable. |
| `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` | Photos, notes, attachments. Without them use `PHOTO_STORAGE=local` only for testing (files are lost on every redeploy). |
| `FIREBASE_SERVICE_ACCOUNT`, `FIREBASE_DATABASE_URL` | Push notifications and live bus. |
| `GEMINI_API_KEY` and/or `AZURE_OPENAI_*`, `AZURE_SPEECH_*` | Learning AI, Ask, spoken voice. |
| `MAPBOX_ACCESS_TOKEN` (optional) | Bus routes that follow roads; otherwise the public OSRM service is used. |
| `PLATFORM_BASE_DOMAIN` (optional) | School addresses like `abc.yourdomain.in`; leave unset until wildcard DNS and TLS exist. |

Leave at their defaults unless measured: `PASSWORD_CHECK_CONCURRENCY` (3), `PASSWORD_CHECK_QUEUE` (300), the rate-limit settings, `RATE_LIMIT_STORE` (counters are kept in MongoDB, shared by all instances).

Website (Vercel): `VITE_API_URL=https://<api>/api`. Set `VITE_TENANT_ROUTING` and `VITE_PLATFORM_BASE_DOMAIN` only together with the backend's `PLATFORM_BASE_DOMAIN`.

## 4. Staging (done once; repeat for later releases)
The steps below were carried out for the first time on 2026-10-26 with the CLI; this is how to do it by hand.
1. Render: New > Blueprint > this repository > branch `staging` > file `render.staging.yaml` (free plan). Fill the `sync: false` values from section 3, with the **staging** database.
2. On the staging database: `npm run migrate` (dry run), read the table, then `npm run migrate -- --apply` (steps in `docs/DEPLOYMENT.md`, section 3). Update the Atlas Vector Search index if the AI features are used there (section 4 of that file).
3. Create one school and a few users there (console or `npm run create-school`), then check:
   - `BASE_URL=https://<staging api> SMOKE_SCHOOL=<code> SMOKE_ID=<admin> SMOKE_PASSWORD=<password> node loadtests/smoke.js` (read-only; the password is read from the environment and never printed).
   - Frontend: `node e2e/crawl-check.mjs --web https://<staging site> --school <code> --password <pw> --admin <id> --teacher <id> --student <id> --parent <id>` and `node e2e/live-check.mjs --web ... --api ...` (the live check writes test data, so only on staging).
4. Look at the Render logs for `request_failed` lines for a day of normal use.

## 5. Production, in this order
Each step needs the owner's go-ahead.
1. **Backup.** `npm run backup` against production (copies every collection to `backups/<timestamp>/`; on a paid Atlas tier also take a snapshot). Keep a copy outside the server.
2. **Dry-run the migration** on production: `npm run migrate`. Read it; do not apply yet.
3. **Quiet time** (a school holiday evening). Tell schools sign-in may blink once.
4. **Merge `staging` into `main`** for the backend. Render deploys; wait for `GET /api/health` to return `{"status":"ok","db":"up"}`.
5. **Apply the migration:** `npm run migrate -- --apply`. It is safe to run twice.
6. **Smoke check:** `loadtests/smoke.js` with a real school admin (or a dedicated test school).
7. **Deploy the website** (merge `staging` into `main` on the frontend; Vercel deploys). Open it on a phone, sign in as each role.
8. Watch for an hour: Render logs, sign-in success, `SIGN_IN_BUSY`, `request_failed`.

**Rollback.** Render > service > Deploys > roll back to `01b8f3f`. The database changes only add documents and indexes, so the old code keeps working; to restore data as well: `npm run backup -- --restore backups/<timestamp> --confirm`. Vercel: promote the previous deployment.

## 6. After go-live
- **Uptime:** a free monitor (for example UptimeRobot) on `/api/health` every 5 minutes, mailing you on failure. Render's own alerts for failed deploys.
- **Backups:** Atlas free tier has no automatic backups. Either move to a tier with snapshots or schedule `npm run backup` from a machine that keeps copies.
- **Capacity:** one instance handled 1,000 simulated users at once in a laptop test. Sign-in, the heaviest step, tops out near 60 per second per instance. If real use gets near this, add a second instance (counters and sign-in limits are shared through MongoDB). Measure on the real hosting before promising a number to a school.
- **Logs worth searching:** `request_failed` (server errors), `SIGN_IN_BUSY` (sign-in overload).
- **Keys:** rotate `JWT_SECRET` and provider keys on a schedule; rotating `JWT_SECRET` signs everyone out.

## 7. Known limits
- Sessions last 24 hours. A person can sign out of all devices ("log out everywhere"), and changing the password does the same.
- `GET /api/fees/<id of another school's student>` answers 200 with an empty list instead of 404. Nothing leaks; it is just untidy.
- A student or parent without a bus gets a 404 from the bus endpoint (the screens handle it; the browser console logs it).
- Passkeys were deferred on purpose.
