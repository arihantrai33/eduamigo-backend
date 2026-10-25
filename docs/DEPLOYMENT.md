# Deploying the hardening release

Follow these steps in order. Steps 1 to 4 must be done before the new backend goes live.

## 1. Rotate secrets
The file `.env.save` with real credentials was once committed locally. It was removed before any push,
but treat those values as exposed if the repository was ever copied or shared:
- MongoDB Atlas: create a new database user password and update `MONGO_URI`.
- `JWT_SECRET`: generate a new one (at least 32 characters). Everyone will need to log in again.
  `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`
- Gemini API key and Cloudinary API secret: regenerate in their consoles.

The server now refuses to start if `JWT_SECRET` is missing or shorter than 32 characters.

## 2. Configure Render environment variables
Required: `MONGO_URI`, `JWT_SECRET`, `CORS_ORIGINS` (your Vercel URL), Cloudinary and Gemini keys.
Optional: `PLATFORM_BASE_DOMAIN` (for example `eduamigo.com`) turns on `{school code}.eduamigo.com` addresses for schools (see `docs/SIGN_IN.md`); leave it unset until wildcard DNS and TLS exist.
For online fee payments also set `DATA_ENCRYPTION_KEY` (see `docs/PAYMENTS.md`).
For student photos set `PUBLIC_API_URL` to the API's own https address (for example `https://eduamigo-backend.onrender.com`): the app and the API are on
different domains, and photo links must be absolute. See `docs/STUDENT_PHOTOS.md`.
See `.env.example` for the full list.

## 3. Back up and migrate the database
1. Back up: `npm run backup` (saves every collection to `backups/<timestamp>/`, works on the free M0 tier).
   On paid tiers also take an Atlas snapshot (Backup > Snapshots).
   To roll back: `npm run backup -- --restore backups/<timestamp> --confirm`.
2. Dry run (no changes): `npm run migrate`
3. Review the table, then apply: `npm run migrate -- --apply`
   - Add `--rotate-driver-tokens` to issue new, longer driver codes (drivers must enter the new code).
4. The migration is safe to run again; a second run reports no pending changes.
5. Receipt numbers: the dry run reports `receipts.duplicate_numbers_need_review` if two receipts in one school share a number
   (old receipts used random numbers). Nothing is changed. Review those fees by hand; until they are fixed the unique index
   `receipt_unique_per_school` cannot be built (the apply step reports `indexes.failed.Fee` and carries on). New receipts are numbered
   RCPT-<year>-<6 digits> per school from an atomic counter.

Added for configurable roles and teaching assignments (both only report on a dry run):
- `roles.system_roles_missing`: schools without their built-in roles (admin, accountant, teacher as `SchoolRole`). Apply creates them equal
  to the old code table, so nobody's access changes. New schools get them when they are onboarded; until a school is seeded it falls back
  to the code table.
- `teaching.assignments_from_lists`: one assignment per (class, subject) from each teacher's lists, for teachers who have subjects and
  classes but no assignments. Access stays exactly as before. `teaching.cross_product_teachers_to_review` counts teachers with several
  classes AND subjects: the old rule let them act on every combination; ask the school to narrow them in Teachers > Teaching assignments.
- Roll back: both only add documents (`schoolroles`, `teachingassignments`); restoring the backup or dropping those collections returns to
  the previous behaviour because the code falls back to the lists and the table.

What it does: adds the missing `school` on older records, normalises class/section values, removes old
notifications that were visible to every parent, merges duplicate attendance, re-queues notes for the AI,
adds bus tracking ids and rebuilds indexes as per-school unique indexes.

## 4. Update the Atlas Vector Search index
Edit `vector_index` on `noteembeddings` to include `section` as a filter field (see `docs/AI_REVISION.md`).
All notes are re-embedded automatically by the job after the migration.

## 5. Deploy
Deploy the backend first, then the frontend (Vercel). Check `GET /api/health` returns `{"status":"ok","db":"up"}`.

## 6. Firebase (bus tracking)
The driver app now sends location and trip events to the API, and the server writes them to Firebase
with the service account. Browsers only read.

1. In Render, add `FIREBASE_SERVICE_ACCOUNT` with the service account JSON (Firebase console >
   Project settings > Service accounts > Generate new private key), pasted as one line.
2. In Firebase console > Realtime Database > Rules, publish:

```json
{
  "rules": {
    "transport": {
      "$trackingId": { ".read": true, ".write": false }
    },
    ".read": false,
    ".write": false
  }
}
```

Parents know only the random tracking id of their child's bus. Remove any old `leaves` data from
the database: parent leave requests now go through the API.

## 7. Platform owner account (once)
`npm run create-platform-admin -- --name "Your Name" --email you@eduamigo.in`

Sign in at `POST /api/platform/login`. See `docs/SAAS.md` for plans, add-ons and the platform API.
After the migration, every school that existed before has a school code and the premium plan with no end date;
change plans from the platform API when you are ready.

## Onboarding a new school
From the platform API (`POST /api/platform/schools`), or:

`npm run create-school -- --name "School Name" --admin-name "Principal Name" --admin-email principal@school.in --city Jaipur --plan standard --trial-days 30`

The command prints the school code and a temporary password. The admin must set their own password at first login.

## Go-live checklist (SaaS release)

Do these in order. Nothing here is needed for local testing (`npm run demo`).

**Before the day**
1. Atlas on a paid tier (M10 or higher, Mumbai region) for automatic backups. M0 has none.
2. A staging copy: a second Render service and Vercel project pointing at a separate Atlas database. Restore a
   backup there (`npm run backup -- --restore <folder> --confirm` with that database's `MONGO_URI`), run the
   migration, and click through every role.
3. Email for password reset codes: create a Brevo (or Resend) account, verify the sending domain, and set
   `EMAIL_PROVIDER`, `EMAIL_FROM` and the API key on Render. Without it, codes are not sent (a warning is logged).
4. CI is green on GitHub (backend tests, frontend and console builds).

**On the day**
1. Tell users: the app asks for the school code first; students sign in with their admission number, parents
   with their mobile number, staff with email as before. Passwords do not change.
2. Back up: `npm run backup` and, on paid tiers, an Atlas snapshot.
3. Migration dry run: `npm run migrate`. Read the table (school codes, admission numbers, buses given a school,
   anything marked "review by hand"). Then `npm run migrate -- --apply`.
4. Merge `hardening/saas-foundation` into `main`; deploy the backend first, then the school app.
5. `GET /api/health` returns `{"status":"ok","db":"up"}`.
6. Owner account: `npm run create-platform-admin -- --name "..." --email ...`.
7. Deploy the console (`eduamigo-console`, a static site on its own private address). Add its address to
   `CORS_ORIGINS`.
8. In the console: set plan and add-on prices, then for each school check the plan, trial or paid-until date,
   and branding. Existing schools are migrated to Premium with no end date, so nothing is switched off.
9. Share each school's link `https://<school app>/s/<CODE>` (or a QR code of it) with its staff and parents.

**Environment variables added in this release**

| Variable | Needed | Purpose |
|---|---|---|
| `EMAIL_PROVIDER`, `EMAIL_FROM`, `BREVO_API_KEY` or `RESEND_API_KEY` | For password reset | Sends reset codes |
| `GST_RATE` | Optional (default 18) | Tax on EduAmigo invoices |
| `DATA_ENCRYPTION_KEY` | For online payments | Encrypts each school's Razorpay keys |

**Rollback**: redeploy the previous backend and frontend, then restore the backup taken in step 2
(`npm run backup -- --restore backups/<time> --confirm`). The migration only adds fields and indexes, so the
old version keeps working on migrated data except for logins created after go-live without an email.
