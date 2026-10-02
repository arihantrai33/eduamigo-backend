# Who can do what

EduAmigo uses two layers of access control:

1. **Permissions** (what kind of action): defined once in `src/config/permissions.js` and checked on every
   staff route with `requirePermission(...)`.
2. **Row-level rules** (which records): applied inside controllers. Every query is limited to the user's
   school; teachers only see their assigned classes; students only themselves; parents only their linked children.

`tests/access-matrix.test.js` tries every listed endpoint with every role and fails if the result does not
match this table. Update the table, the config and the test together.

## Roles

| Role | Who | Portal |
|---|---|---|
| Admin | Principal, school administrator | Admin portal, everything in their school |
| Accountant | Fee counter / accounts staff | Admin portal, finance screens only |
| Teacher | Teaching staff | Teacher app, limited to assigned classes |
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
| View parents | ✓ | ✓ | |
| Manage parents | ✓ | | |
| User accounts, password resets | ✓ | | |
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
