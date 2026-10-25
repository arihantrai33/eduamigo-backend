# Who can do what

EduAmigo uses two layers of access control:

1. **Permissions** (what kind of action): defined once in `src/config/permissions.js` and checked on every
   staff route with `requirePermission(...)`.
2. **Row-level rules** (which records): applied inside controllers. Every query is limited to the user's
   school; teachers only see their assigned classes; students only themselves; parents only their linked children.

`tests/access-matrix.test.js` tries every listed endpoint with every role and fails if the result does not
match this table. Update the table, the config and the test together.

## How a permission is decided now

One function decides: `src/services/authorization.js` (`can`, `effectivePermissions`, `explain`, `scopeOf`). Controllers, routes and
middleware never read the role table or compare a role name (`tests/authorization.test.js` fails if they do).

1. The account type (`User.role`) gives a base set: the built-in role of the school, stored as data (`SchoolRole`, seeded per school).
2. Extra roles (`User.extraRoles`) add permissions on top. The union is used; where scopes differ the widest wins; a family with no
   scope is `none` (fail closed). Roles are read on every request, so a removed or switched-off role stops working on the next request.
3. The plan removes permissions whose module the school has not bought.
4. Scope (`school` / `assigned` / `own`) decides which records: `services/scope.js`. Subject-level actions (marks) use teaching
   assignments when a teacher has any (`services/teaching.js`), otherwise the teacher's class and subject lists.

Custom roles are managed at `/api/roles` (needs `roles.manage`; listing needs `roles.view`). A person can only give permissions and
scopes they hold, cannot change or assign their own roles, and the administrator role cannot be an extra role. The last active
administrator cannot be deactivated. Every change is in the audit log. Full table: the frontend repo's
`docs/production-readiness/ROLE_PERMISSION_MATRIX.md`.

The assistant (`src/assistant`) still decides by account type and does **not** widen for custom roles: a staff account or a teacher
with a fee role gets no school-wide fee data through it (`tests/assistant-roles.test.js`).

## Roles

| Role | Who | Portal |
|---|---|---|
| Admin | Principal, school administrator | Admin portal, everything in their school |
| Accountant | Fee counter / accounts staff | Admin portal, finance screens only |
| Staff | Office, library, transport, any non-teaching employee | Admin portal; sees only what the roles given to them allow (none by default) |
| Teacher | Teaching staff | Teacher app, limited to assigned classes (extra roles open office screens) |
| Student | Enrolled student | Student app, own data |
| Parent | Guardian | Parent app, linked children only |
| Driver | Bus driver | Driver screen, signs in with the bus driver code (no account) |

## Staff permissions

| Permission | Admin | Accountant | Teacher |
|---|:-:|:-:|:-:|
| View students | ✓ | ✓ | ✓ (own classes) |
| Add / edit / deactivate students | ✓ | | |
| View teachers | ✓ | | ✓ (no salary or personal details) |
| Manage teachers, assign classes | ✓ | | |
| Sessions, classes, sections, subjects, class teachers | ✓ | | |
| View sessions and the class list | ✓ | ✓ | ✓ |
| Student class history | ✓ | ✓ | ✓ |
| View parents | ✓ | ✓ | |
| Manage parents | ✓ | | |
| User accounts, password resets | ✓ | | |
| Activity log (who changed what) | ✓ | | |
| Mark attendance | ✓ | | ✓ (own classes) |
| Attendance dashboards and reports | ✓ | | |
| Enter and publish marks (against a scheduled exam) | | | ✓ (own classes and subjects) |
| Reopen published marks | ✓ | | |
| View results | ✓ | | ✓ (own classes) |
| Exam schedule | ✓ | | |
| Report cards (view, print, remarks) | ✓ | | ✓ (own classes) |
| Admissions (enquiries, applications, admit) | ✓ | | |
| Timetables | ✓ | | |
| View fees and summaries | ✓ | ✓ | |
| Collect fees, issue receipts | ✓ | ✓ | |
| Online payment reconciliation | ✓ | ✓ | |
| Fee structures, bill students | ✓ | ✓ | |
| Salaries and staff leave | ✓ | | |
| Review leave requests | ✓ | | ✓ (students of own classes) |
| All leave records | ✓ | | |
| Announcements, notifications, events | ✓ | | |
| Transport | ✓ | | |
| Library | ✓ | | |
| Bulk operations and promotion | ✓ | | |
| Upload study material | ✓ | | ✓ (own classes) |
| School settings, online payment keys | ✓ | | |
| Message anyone from one inbox | ✓ | | |

## Self-service

| Action | Student | Parent |
|---|:-:|:-:|
| Own / child's profile, attendance, results, fees, timetable | ✓ | ✓ (each linked child) |
| Report card | ✓ | ✓ (each linked child) |
| Pay fees online, download receipts | ✓ | ✓ (each linked child) |
| Apply for leave | ✓ | ✓ (for a child) |
| AI revision | ✓ | |
| Bus tracking and SOS | ✓ | ✓ |
| Chat | Teachers of own class, admin | Teachers of child's class, admin, accountant |

## Payments
- Each school uses its own Razorpay account. Key secrets are encrypted at rest (AES-256-GCM) and never sent back to the browser.
- A payment is applied only after its signature is verified (browser confirmation or webhook), and only once even if both arrive together.
- The webhook URL carries the school ID; the payload is accepted only when it is signed with that school's webhook secret.

## Account safety
- New accounts get a temporary password shown once to the admin; the user must set their own at first login.
- Changing a password signs out every other session.
- Deactivated users and suspended schools are blocked on every request, not only at login.
- Login is rate limited and uses one error message for unknown email and wrong password.
