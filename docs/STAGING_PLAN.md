# Staging deployment and migration plan (pilot with three schools)

Status: **prepared, not executed.** Nothing here has been run against a real staging environment yet. Production is not touched at any step.

## 1. What must exist before a first external school
| Area | Requirement | Why |
|---|---|---|
| API hosting | A paid, always-on Render service (not the free plan), Node 24, in the same region as the database; start with one instance and size it from the load test | The free plan sleeps, which misses the 9:00 fee-reminder job and makes the morning attendance rush slow to start |
| Database | MongoDB Atlas dedicated tier with **continuous cloud backup** (point-in-time restore), same region as the API; a separate staging database name ending `_staging` | The free shared tier has no point-in-time recovery |
| Files | Cloudinary account with `authenticated` delivery available; the API address in `PUBLIC_API_URL` | Student photos are private (see `docs/STUDENT_PHOTOS.md`) |
| Monitoring | An uptime check on `/api/health`; an error tracker (needs your approval, it is a new external service); Atlas alerts (connections, CPU, disk) and Render alerts (restarts, 5xx); logs kept long enough to search by `requestId` | There is no alerting today |
| Backups | Atlas continuous backup, plus `npm run backup` daily to storage outside Atlas; a **restore drill** done once before onboarding | A backup that was never restored is not proven |
| Secrets | New `JWT_SECRET`, `DATA_ENCRYPTION_KEY`, database password, Gemini/Azure and Cloudinary keys for production (production rotation needs your approval) | `docs/DEPLOYMENT.md` step 1 |
| Config | `CORS_ORIGINS` (required in production), `PUBLIC_API_URL`, `TENANT_GUARD` left at its default (enforce) | The server refuses to start without CORS_ORIGINS |

## 2. Staging environment
`render.staging.yaml` (validated) creates the service `eduamigo-staging` from branch `staging`. It is separate from the production service.
Create it in the Render dashboard (Blueprint) or with `render services create`, and enter the values it asks for. Use:
a separate Atlas database user limited to `eduamigo_staging`; the staging frontend's address in `CORS_ORIGINS`; the staging service's own https address in `PUBLIC_API_URL`.
Staging should have its own Cloudinary folder or account so test photos never mix with real ones, and **no** production Firebase service account (bus tracking is not tested in staging).

## 3. Order of work
Owner: **you** = needs your console or approval. **me** = I can do it from the terminal once you are signed in to the tools.

1. (you) Sign in: `gh auth login`, `atlas auth login` (press Enter on each choice; finish in the browser). `render login` and `vercel login` are done.
2. (you) Approve the plan sizes above and the error tracker.
3. (me) Push the branch (`hardening/pilot-readiness`) to `staging`; (me) create the Atlas staging database user; (me) create the Render service; set the environment.
4. (me) `GET /api/health` must return `{"status":"ok","db":"up"}`.
5. (me) Migration on staging: `npm run backup`, `npm run migrate` (dry run, read the table, check `receipts.duplicate_numbers_need_review`), then `npm run migrate -- --apply`. Run it a second time: it must report no changes.
6. (me) Atlas Vector Search index `vector_index` with `section` as a filter field (`docs/AI_REVISION.md`).
7. (me) `loadtests/seed.js` for 3 schools; create the platform owner account; deploy the staging frontend with `VITE_API_URL` pointing to staging (Vercel Preview-only variable, so production is untouched).
8. (me) Checks in section 4. (you) Open the staging app on a phone and click through one flow per role.
9. (me) Load tests (`loadtests/README.md`) and record the results.
10. (you) Go / no-go for the first school using section 6.
11. Production, only after you approve each of: production backup, secrets rotation, migration dry run and apply, deploy, `migratePhotos` stage A, a check, and much later stage B.

## 4. Checks on staging (each one must be shown to pass)
- Health, then a sign-in as admin, teacher, parent and student of each of the 3 schools.
- `loadtests/isolation-check.js`: 0 cross-school data. (The in-process version, `tests/isolation-sweep.test.js`, already passes: 98 GET and 110 write routes.)
- **Photos against the real Cloudinary** (not yet verified anywhere): upload a photo; open its `/api/photos/...` link (200); take the stored key and open it directly on Cloudinary without a signature (must fail); wait past the link's expiry (404); try a text file renamed `.png` (400).
- **Real client address behind Render's proxy:** two different phones must be counted separately by the limiters (`trust proxy` is set to 1; confirm `req.ip` is the phone, not Render).
- Double-tap attendance on a class from two devices: both succeed, one row per student, one message to each parent.
- Two staff admitting into the same class at once: different roll numbers.
- Record several payments quickly: receipt numbers `RCPT-<year>-000001, 000002, ...` per school.
- The 9:00 fee reminder job runs once (check logs), and not twice if the service restarts.
- A forced error returns a message with `requestId`, and that id finds the cause in the logs.
- Restore drill: restore the latest backup into a scratch cluster and run `loadtests/verify.js` on it.

## 5. Rollback
| What | How |
|---|---|
| Bad deploy | Render: redeploy the previous successful deploy. The migration is additive, so the old code keeps working |
| Bad data change | Atlas point-in-time restore to just before the change (needs the paid tier); `npm run backup -- --restore backups/<timestamp> --confirm` for a dump |
| Photos, stage A | `db.students.updateMany({ photoKey: { $exists: true } }, { $unset: { photoKey: 1 } })`: old public photos work again |
| Photos, stage B | Cannot be undone. Only after stage A was checked in the app |
| Receipt index | `db.fees.dropIndex('receipt_unique_per_school')` (numbers then continue from the counter) |

## 6. Go / no-go for the first external school
Go only if all of these are true: staging checks pass; every load-test target is met on the paid tiers (or the gap is understood and accepted by you);
backup restore drill succeeded; uptime check and error tracker alert you; secrets for production rotated; the migration dry run on a copy of production is reviewed;
you have approved production deployment.

## 7. Not verified yet (do not assume)
Real Cloudinary private delivery; the real client address behind the proxy; Atlas Vector Search index state; the live Render environment variables;
database query plans on realistic data (run `explain` for the attendance, fee and student lists); how long a 1,000-student year-end takes on Atlas; push notifications
(the app stores device tokens but the server does not send pushes); camera location data in stored photos; accessibility.
