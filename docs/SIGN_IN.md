# Sign-in, sessions and password reset

## Who signs in with what

| Role | Login ID | School code needed |
|---|---|---|
| Student | Admission number | Yes |
| Parent | Mobile number (any format: `98765 43210`, `+91-9876543210`, `09876543210`) or email | Yes for mobile |
| Teacher, admin, accountant | Email (mobile also works) | No for email |
| EduAmigo staff | Email, at `POST /api/platform/login` only | No |

`POST /api/users/login`

```json
{ "schoolCode": "GVPS", "identifier": "1024", "password": "..." }
```

The old `{ "email", "password" }` body still works. Unknown IDs, wrong school codes and wrong passwords all get
the same 401 answer. A number that is not an email without a school code gets 400 "Please choose your school first".
Rate limit: 10 attempts per 15 minutes per IP and login ID.

The apps get the school code from the "find your school" screen (see `docs/SAAS.md`) and send it with every sign-in.

## Accounts without email

- Students: email is optional. Credentials returned when a student is created or admitted:
  `{ schoolCode, loginId (admission number), admissionNo, email, password }`.
- Parents: a parent login is created when a parent email **or** a valid 10-digit parent mobile is given. A second
  child with the same parent mobile (or email) in the same school is linked to the same parent login
  (`linkedExistingParent: true`). Two parent logins in one school cannot share a mobile number.
- Staff accounts always need an email (checked by the User model).
- Emails stay unique across the platform when present.

## Sessions

- Tokens last `JWT_EXPIRES_IN` (default 7 days) and carry the user's `tokenVersion`.
- `POST /api/users/logout-all` signs the user out on every device, including the current one.
- Changing or resetting a password (by the user, an admin, a parent or teacher, or with an email code) also ends
  every older session.

## Forgot password

1. `POST /api/users/forgot-password` with `{ email }` or `{ schoolCode, identifier }`.
   The answer is always the same, whether or not the account exists or has an email.
   If the account has an email, a 6-digit code is sent to it (valid 15 minutes, at most one email per minute).
2. `POST /api/users/reset-password` with the same login ID plus `{ code, newPassword }`.
   Five wrong tries cancel the code. Only an HMAC of the code is stored, and expired codes are deleted by MongoDB.

Rate limit: 5 requests per 15 minutes per IP and login ID.

Email settings (`.env`):

```
EMAIL_PROVIDER=brevo        # brevo | resend | log (log = print only; default outside production)
EMAIL_FROM=EduAmigo <no-reply@yourdomain.in>
BREVO_API_KEY=...           # or RESEND_API_KEY=...
```

In production, if no provider is set, codes are not sent and an error is logged.

## Students without email: who can reset their password

`POST /api/students/:id/reset-password` gives a new temporary password (the student must change it on sign-in):

- the student's parent,
- a teacher of the student's class,
- the school admin.

Anyone else gets 404. Every reset is written to the audit log.
Admins can still reset any account with `POST /api/users/:id/reset-password`; the answer now includes `loginId`.

## Migration

`npm run migrate -- --apply` makes existing mobile numbers usable for sign-in and replaces the old
"email must be unique" indexes on users, students and parents with "unique when present" ones.
