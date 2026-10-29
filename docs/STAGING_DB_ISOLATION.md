# Staging database isolation and location-data retention

Status: **plan only. Nothing here has been changed.** Changing a database user or a Render environment variable needs the owner's approval (and an Atlas login, which the CLI on this Mac does not have).

## The problem
Staging (`eduamigo-staging` on Render, database `eduamigo_staging`) connects with the same Atlas user as production (`eduamigo`, same cluster). That user has the `atlasAdmin` role, so a bug or leaked staging secret could read or change production data.

## The fix (about 10 minutes, no cost)
1. Atlas -> Database Access -> Add New Database User, password authentication, auto-generated password (do not reuse the production one).
2. Built-in role: none. Add a **Specific Privilege**: role `readWrite`, database `eduamigo_staging`, collection empty (= all collections of that database only). Name the user `eduamigo_staging_app`.
3. Atlas -> Network Access: keep the same rules (Render needs outbound access; do not open 0.0.0.0/0 if it is not already).
4. Render -> `eduamigo-staging` -> Environment -> change `MONGO_URI` to the new user and keep the database name `eduamigo_staging`. Save (this redeploys staging, about 2 minutes). The CLI cannot edit environment variables; recreating the service is the only CLI route and is not needed.
5. Verify (needs the new URI, never paste it in chat or commit it):
   * the staging health and a login still work;
   * with the new URI, `use eduamigo; db.getCollectionNames()` must fail with "not authorized";
   * `use eduamigo_staging` works.
6. Production keeps its own user and URI. Later, replace production's `atlasAdmin` user with a `readWrite` user on `eduamigo` only (a separate approval, with a backup first).

## Rollback
Put the old `MONGO_URI` back in Render. Delete the new user only after staging works with it.

## Secrets rules
Connection strings live only in Render environment variables and in a local, git-ignored `.env`. The Flutter APK holds none (only the public API URL). `src/config/serviceAccountKey.json` is git-ignored; rotate it if it was ever shared.

## Location data and privacy (as built)
* `BusTripPoint` (sampled GPS points, about one per 15 s): deleted by a database TTL index after **3 days** (`src/models/BusTripPoint.js`). Readable only by the school office (`transport.manage`), not by parents or students.
* The live position (one per bus, overwritten) is on the bus document; it is cleared when the trip ends.
* Parents and students receive only their own bus (checked on every request and every 30 s on an open stream).
* `SosEvent` (new): kept with no expiry so the school can review what was raised. Decide a retention period with the school (a year is typical) and add a TTL index if wanted.
* Not assessed against any regulation (for example the Indian DPDP Act). Parent consent wording and deletion requests on request still need a legal review.
