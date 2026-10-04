# Trying EduAmigo on localhost

`npm run demo` starts the API on http://localhost:8000 with a temporary in-memory database filled with
three demo schools. It never uses `MONGO_URI`, and all data is deleted when it stops (Ctrl+C).

```
# terminal 1 (backend)
npm run demo

# terminal 2 (frontend)
cd ../eduamigo-frontend && npm run dev     # http://localhost:5173
```

Every password is `Demo@1234`. The demo prints the full list of logins.

| School code | Plan and state | What to look for |
|---|---|---|
| GVPS | Premium, trial | Every module; teal branding; parent 9876543210 has two children |
| SCS | Basic, paid | Fees, exams, bus and chat are hidden; opening them by URL shows "Not available" |
| LFS | Standard, trial expired | Read-only: everything opens, saving fails; staff see the red banner |
| AISGAYA, AISCHAKAND | Premium, paid | Allied International School, two campuses (search "allied"); navy placeholder theme; each campus sees only its own data |

Logins: staff `admin@gvps.demo`, `teacher@gvps.demo` (Admin / Teacher tab); students by admission number
`1`, `2`, `3` (Student tab); parents by mobile (Parent tab). Platform owner: `owner@eduamigo.demo` at
`POST /api/platform/login` (no screen yet).

Forgot password codes are printed in the backend terminal instead of being emailed.
The first run downloads a MongoDB binary (about a minute).

## Trying the new version on a copy of real data

```
npm run backup                                          # read-only copy of MONGO_URI into backups/<time>/
npm run demo -- --from-backup backups/<time>            # loads the copy into the temporary database
```

The copy is migrated (admission numbers, school code, plan) and becomes **Allied International School, Gaya**
(code `AISGAYA`, link `http://localhost:5173/s/AISGAYA`) with its saffron branding. The other demo schools (Chakand,
Green Valley, Sunrise, Little Flower) and the owner account are added alongside it with password `Demo@1234`.
Real accounts sign in with their existing password: staff by email, students by admission number (printed at start).
Login accounts the migration could not link to a profile are reported and will not sign in. The source database is never written to, and the
copy disappears when the demo stops. `backups/` holds real personal data: it is git-ignored; delete it when done.
