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

Logins: staff `admin@gvps.demo`, `teacher@gvps.demo` (Staff / Teacher tab); students by admission number
`1`, `2`, `3` (Student tab); parents by mobile (Parent tab). Platform owner: `owner@eduamigo.demo` at
`POST /api/platform/login` (no screen yet).

Forgot password codes are printed in the backend terminal instead of being emailed.
The first run downloads a MongoDB binary (about a minute).
