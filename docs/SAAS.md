# EduAmigo SaaS: plans, add-ons, billing state and the platform console

How EduAmigo sells different features to different schools from one codebase.

## Building blocks

| Piece | Where | What it does |
|---|---|---|
| Feature catalogue | `src/config/features.js` | The sellable modules (fees, exams, transport...) and the default plans |
| Plans | `Plan` collection (falls back to `DEFAULT_PLANS`) | A bundle of features, limits and a price per student per year |
| Add-ons | `AddOn` collection | Price of a single feature bought on top of a plan |
| School subscription | `School.subscription` | Plan, add-ons, per-school overrides, limits, status and dates |
| Entitlements | `src/services/subscription.js` | Works out a school's features, limits and billing state |
| Feature check | `requireFeature()` in `authMiddleware.js` | Blocks a module the school has not bought |

**Core (every plan, never gated):** students, teachers, parents, classes, attendance, timetable, notice board,
notifications, calendar, leave requests, study material, bulk upload and promotion, settings.

**Paid features:** `fees`, `online_payments` (needs `fees`), `exams` (exams, marks, report cards), `admissions`,
`hr`, `transport`, `library`, `chat`, `ai_revision`.

**Default plans** (change them with the platform API, not code):

| Plan | Features | Limits |
|---|---|---|
| basic | core only | - |
| standard | fees, exams, admissions, chat | - |
| premium | everything | 5000 AI questions per month |

## How a school's features are worked out

```
features = plan.features + addOns + enabledFeatures - disabledFeatures
           (a feature whose prerequisite is missing is dropped)
limits   = plan.limits, overridden by subscription.limits
```

- `addOns`: features the school pays for on top of its plan.
- `enabledFeatures` / `disabledFeatures`: custom deals (a free AI trial, a feature switched off on request).

The login and profile responses include `features`, `plan`, `subscription` (state) and only the permissions
of bought features, so the apps show only the menus the school has. A blocked call returns:

```json
{ "success": false, "code": "FEATURE_NOT_IN_PLAN", "feature": "transport", "message": "..." }
```

Other machine-readable codes: `PLAN_LIMIT` (student or AI limit reached), `READ_ONLY`, `SCHOOL_SUSPENDED`.

## Billing state

Worked out from the status and dates on every request (no cron job):

```
trial / active  ->  end date passes  ->  past_due (full access for graceDays, default 7; apps show a warning)
                ->  grace ends       ->  read_only (view everything, change nothing)
suspended (set by EduAmigo, or school.isActive = false)  ->  no sign-in at all
```

- A school paid with no end date (`currentPeriodEnd: null`) stays active.
- Read-only still allows signing in, changing a password and registering a device for notifications.
- Data is never deleted because of billing.
- Background jobs (fee reminders, AI note processing) skip schools that lack the feature or are read-only or suspended.
  Notes of a school without AI stay pending and are processed automatically once the school gets the feature.

## Platform console API (`/api/platform`)

For EduAmigo staff only (role `superadmin`, not linked to any school). Platform tokens have `scope: "platform"`:
they do not work on school APIs, and school tokens do not work here. Every change is written to `AuditLog`.

Create the first owner account:

```
npm run create-platform-admin -- --name "Your Name" --email you@eduamigo.in
```

| Method | Path | Purpose |
|---|---|---|
| POST | `/login` | `{ email, password }` -> 12-hour platform token |
| GET | `/stats` | Schools by state, total active students and users |
| GET | `/catalog` | Features, plans (with prices) and add-on prices |
| PUT | `/plans/:code` | Create or edit a plan: `{ name, description, features, limits, pricePerStudentYear, isActive }` |
| PUT | `/addons/:feature` | Add-on price: `{ pricePerStudentYear, flatPricePerYear, isActive }` |
| GET | `/schools?search=&state=&page=` | Schools with plan, state and usage (active students, users by role, last sign-in, AI questions this month) |
| POST | `/schools` | Onboard: `{ name, code?, city, adminName, adminEmail, plan, addOns, trialDays }` -> returns the admin's temporary password |
| GET | `/schools/:id` | One school with usage and its admins |
| PATCH | `/schools/:id` | Name, code, city, contacts, `customDomain`, `branding`, `isActive` |
| PATCH | `/schools/:id/subscription` | `{ plan, addOns, enabledFeatures, disabledFeatures, limits, status, trialEndsAt, currentPeriodEnd, graceDays, notes }` |
| POST | `/schools/:id/support-session` | `{ reason }` -> 1-hour token acting as the school's admin; every change made with it is audited |
| GET | `/audit?school=&action=` | Audit log |

Typical renewal: `PATCH /schools/:id/subscription { "status": "active", "currentPeriodEnd": "2027-03-31" }`.

## Finding a school (before sign-in)

Public, rate-limited (30 requests per minute per IP), suspended schools are hidden. They return only
`code, name, city, appName, logoUrl, primaryColor, tagline`.

| Path | Use |
|---|---|
| `GET /api/public/schools?search=green` | "Find your school" search (3+ characters, max 10 results) |
| `GET /api/public/schools/GVPS` | Code typed by the user, or a school link / QR code |
| `GET /api/public/schools/by-domain?host=erp.school.edu.in` | A school's own portal domain |

Suggested app flow: splash -> saved school? -> branded sign-in; otherwise "find your school" (code, search or QR)
-> confirm card with logo -> save on the device -> branded sign-in with a "change school" link.

## Branding

- Each school has a `code` (3-12 letters/digits, generated from the name if not given, e.g. "Green Valley Public School" -> `GVPS`).
- `branding`: `appName`, `logoUrl`, `primaryColor` (`#RRGGBB`), `tagline`. The school admin edits these at
  `PUT /api/schools/me/branding` (multipart, optional `logo` file); EduAmigo can also set them from the platform API.
- `customDomain`: set by EduAmigo. Browsers on that domain are allowed by CORS automatically (https only).
  Point the domain's DNS to the frontend host and add it there as well.

## Activity log (audit trail)

Every successful change to sensitive records is recorded by the `audited(action, targetType, target)` route
middleware (`src/middleware/auditTrail.js`): marks saved, published and reopened; fees created and collected;
fee structures; students created, updated, removed and promoted; logins created, reset and deactivated; exams;
salaries; attendance; sessions and classes; school profile, branding and payment settings; online payments verified.

Each entry has the school, who did it (user and role, or "EduAmigo support" during a support session), the action,
the record, and a trimmed copy of the request. Passwords, tokens, secrets and keys are replaced with `[hidden]`.
Failed requests are not recorded. Admins read their school's log at `GET /api/audit` (permission `audit.read`,
filters `action` prefix, `actor`, `from`, `to`, paged). The platform owner reads every school's log at
`GET /api/platform/audit`.

## Billing schools (invoices)

Prices: plan `pricePerStudentYear` (`PUT /api/platform/plans/:code`) and add-on `pricePerStudentYear` or
`flatPricePerYear` (`PUT /api/platform/addons/:feature`). A custom deal per school: `discountPercent` on
`PATCH /api/platform/schools/:id/subscription`. GST rate: `GST_RATE` (default 18).

An invoice covers a period and is a snapshot made when it is created:

- plan line = active students x plan price x share of the year (92 days = 0.25)
- each bought add-on not already in the plan = active students x its price (or its flat price) x share
- discount line, then GST on the discounted subtotal
- features given free as a custom deal (`enabledFeatures`) are not billed; anything without a price is left
  out and reported in `warnings`; an invoice with nothing to bill is refused

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/platform/schools/:id/invoice-preview?from=&to=` | Lines, totals and warnings, nothing saved |
| POST | `/api/platform/schools/:id/invoices` | `{ from, to, dueDate?, notes?, issue? }` -> `INV-<year>-0001` |
| GET | `/api/platform/invoices?status=&school=` | List with totals per status |
| PATCH | `/api/platform/invoices/:id` | `{ action: "issue" \| "mark_paid" \| "void", paymentRef? }` |
| GET | `/api/schools/me/invoices` | The school's issued and paid bills (admins) |

Status flow: draft -> issued -> paid, or draft/issued -> void. Marking an invoice paid makes the school's
subscription active and moves its paid-until date to the end of the invoice period (if later). Every billing
action is in the platform audit log.
