# Running the hosted demo (existing staging service and database)

The shareable demo reuses the existing Render service `eduamigo-staging` and the Atlas database `eduamigo_staging`. No separate service or cluster is created. Everything in it is fictional.

## Database safety (read first)

The Render service must connect with a database user that can read and write **only** `eduamigo_staging`. A user with the `atlasAdmin` role (access to every database on the cluster, including the production database `eduamigo`) must not be used for the shared demo. Create a user with the built-in role `readWrite` on `eduamigo_staging` (Atlas > Database Access), put its connection string in the staging service's `MONGO_URI`, and keep the admin user for maintenance only.

## What is in the demo database

Five fictional schools: Green Valley Public School, Sunrise Convent School, Little Flower School, Harmony Hills Academy (North and South campus). Optionally, one more fictional school per prospect (below). Off on purpose: AI (no AI keys), payments, email, SMS, push.

## Add a demo school named for a prospect (adds only, never deletes)

```bash
MONGO_URI="<staging uri, database eduamigo_staging>" DEMO_PASSWORD="<12+ characters>" SEED_DEMO_OK=yes \
  npm run demo:add-school -- --name "Example Public School" --code EXPS --city Patna --color "#0A7E8C"
```

Creates one school with an admin, a teacher, three students and two parent logins (`admin@exps.demo`, `teacher@exps.demo`, admission numbers `1`..`3`, parent phone numbers printed by the script), a month of invented fees, attendance, exams, notices and a bus route. The people are invented. Add `--logo-url https://...` only if the school has authorised its logo; the tagline reads "Demo with sample data". It refuses a database not ending in `_staging`/`_demo`, an existing school code, and any change to an existing school. Tests: `tests/prospect-demo.test.js`.

This does not imply any partnership or affiliation with the school; say so when showing it.

## Reset (only for a database named *_demo)

`npm run demo:reset` empties and refills a database whose name ends in `_demo` (see `src/scripts/resetDemo.js`). It **refuses** `eduamigo_staging` and production. The shared staging database has no reset: testers' changes accumulate; remove them with targeted clean-up or move the demo to its own `_demo` database later.

## Cold starts

On Render's free plan the service sleeps after about 15 minutes without traffic and the next request takes about 30 seconds. The app shows a "server is waking up" hint. An always-on instance (Starter, about 7 USD per month) removes this.
