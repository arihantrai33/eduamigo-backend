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
See `.env.example` for the full list.

## 3. Back up and migrate the database
1. In Atlas, take an on-demand snapshot (Backup > Snapshots).
2. Dry run (no changes): `npm run migrate`
3. Review the table, then apply: `npm run migrate -- --apply`
   - Add `--rotate-driver-tokens` to issue new, longer driver codes (drivers must enter the new code).
4. The migration is safe to run again; a second run reports no pending changes.

What it does: adds the missing `school` on older records, normalises class/section values, removes old
notifications that were visible to every parent, merges duplicate attendance, re-queues notes for the AI,
adds bus tracking ids and rebuilds indexes as per-school unique indexes.

## 4. Update the Atlas Vector Search index
Edit `vector_index` on `noteembeddings` to include `section` as a filter field (see `docs/AI_REVISION.md`).
All notes are re-embedded automatically by the job after the migration.

## 5. Deploy
Deploy the backend first, then the frontend (Vercel). Check `GET /api/health` returns `{"status":"ok","db":"up"}`.

## 6. Firebase Realtime Database rules
Parents now receive a separate tracking id instead of the driver secret. The database rules should still
stop anonymous writes. Until drivers sign in with Firebase Auth, restrict writes to the `transport` path to
the backend service account by moving location writes to `POST /api/transport/driver/:token/update-location`
(already available) and setting:

```json
{
  "rules": {
    "transport": {
      "$trackingId": { ".read": true, ".write": false }
    }
  }
}
```

The driver app currently writes to Firebase directly; switch it to the API endpoint before tightening this rule.

## Onboarding a new school
`npm run create-school -- --name "School Name" --admin-name "Principal Name" --admin-email principal@school.in --phone 98xxxxxxxx`

The command prints a temporary password. The admin must set their own password at first login.
