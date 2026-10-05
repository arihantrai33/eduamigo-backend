# EduAmigo architecture

```
Browser / phone (React + Vite SPA, 390 px app frame; admin desktop)
  | axios + bearer JWT        (utils/session.js signs out on 401 / suspended school)
  v
Express 5 API  (src/app.js)
  helmet, CORS (configured origins + schools' own domains), JSON 1 MB, central error handler (no stack traces to clients)
  protect  -> JWT verify -> user + school + entitlements (plan, add-ons, read-only / suspended)
  requireFeature(plan feature) / requirePermission / authorizeRoles
  routes -> controllers (validation, row-level rules) -> services (business rules) -> Mongoose models
  v
MongoDB (every document carries `school`)          Azure OpenAI / Gemini      Razorpay    Cloudinary    Firebase (bus)
```

* **Tenancy.** `req.schoolId` comes from the verified user, never from the request. Every model has `school`; queries filter by it.
* **Plans.** `config/features.js` defines features; a school's features are plan + add-ons + overrides
  (`services/subscription.js`). The API refuses a module the school has not bought; the app hides its menus.
* **Permissions.** One table (`config/permissions.js`); routes check permissions, not role lists.
* **Jobs** (`src/jobs`): fee reminders and note embedding, started with the server (`DISABLE_JOBS=true` for demos and tests).
* **Assistant.** `src/assistant`, self-contained; see `UNIFIEDAI_ARCHITECTURE.md`.
* **Frontend.** Pages per portal under `src/pages/{student,parent,teacher,admin,driver}`, shared components, a small theme
  layer (`utils/theme.js`) that turns the school's brand colour into CSS variables, `ErrorBoundary` at the root and around
  the assistant.

Conventions worth knowing: controllers return `{ success, data }` (login returns `token` and `user` at the top level);
errors are `{ success: false, message }`; ids are checked with `isValidId`; mass assignment is prevented with `pick`.

Local run: `npm run demo` (in-memory MongoDB, demo schools, password `Demo@1234`) and `npm run dev` in the frontend; see `LOCAL_DEMO.md`.
Production: `DEPLOYMENT.md`.
