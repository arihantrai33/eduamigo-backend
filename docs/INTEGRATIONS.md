# Email, SMS and phone codes (owner console)

Settings live in the owner console under **Integrations**. They are platform-wide (not per school) and only the platform owner (`superadmin`, platform token) can read or change them.

## What exists
| Part | Where | Notes |
|---|---|---|
| Settings storage | `models/PlatformSetting.js` | one document per integration (`email`, `sms`); secrets encrypted with `services/secrets.js` (AES-256-GCM, key `DATA_ENCRYPTION_KEY`) and excluded from queries by default |
| Email (SMTP) | `services/integrations.js` | nodemailer; host, port (25/465/587/2525), SSL or STARTTLS (none is refused in production), timeout, from/reply-to |
| SSRF guard | `services/netGuard.js` | the mail host is resolved, every address must be public, and the connection goes to the checked address (no rebinding). `ALLOW_PRIVATE_SMTP_HOSTS=true` disables it for local mail catchers only |
| SMS adapters | `services/sms.js` | `test` (sends nothing), `msg91`, `twilio` |
| Phone codes | `services/otp.js`, `models/PhoneOtp.js` | 6 random digits (`crypto.randomInt`), keyed hashes only, expiry, single use, attempt limit, resend wait, hourly cap per phone |
| Logs | `models/IntegrationLog.js` | sanitized (no secret, code or message body; recipients masked), 90-day TTL |
| Routes | `routes/platformRoutes.js` under `/api/platform/integrations` and `/api/platform/health` | provider-contacting actions share `integrationTestLimiter` |
| Audit | `platform.integration_saved / _verified / _test / _confirmed` | field names and booleans only |

## States, in plain terms
- **Saved** is not **verified**. Email can only be switched on after *Verify connection* (a real connect and login, no message sent). Changing the server, login or sender clears the verification and switches email off.
- **Connected** means the server accepted a test message. **Verified** needs a person to confirm that it arrived ("It arrived").
- Password reset email uses the saved SMTP settings when email is on; otherwise it falls back to the environment provider (`EMAIL_PROVIDER`).
- SMS in **test mode** never contacts a provider and returns the code to the owner only when the provider is `test`. A real provider can be switched on in production mode only after one accepted test send.
- Phone codes are not yet used by any school sign-in (school users reset passwords by email). The service never looks up accounts, so its answers cannot reveal whether a number or email belongs to anyone.

## What has been verified and what has not
| Check | Status |
|---|---|
| SMTP login, wrong password, test message, SSRF refusal, secret masking, access control, audit and log redaction | COMPLETE_VERIFIED against a **local SMTP server written in the test** (`tests/integrations.test.js`). That proves the protocol path, not a real provider |
| OTP request, expiry, wrong code, attempt lock, replay, cooldown, hourly cap, no enumeration | COMPLETE_VERIFIED in automated tests (test provider) |
| MSG91 and Twilio request shape and error handling | MOCKED only (axios replaced); the adapters were written from the providers' public APIs and **never run with real credentials** |
| Delivery of a real email to a real inbox | UNVERIFIED (needs your SMTP account) |
| Delivery of a real SMS | UNVERIFIED (needs provider account and DLT approval) |

## India: what real SMS needs
The business must be registered on a telecom operator's **DLT** platform with a registered **sender ID (header)** and an approved **OTP template**; the SMS provider must link them to your account. An API key alone does not deliver messages. Approval takes days. Until then keep mode **Test**.

## Setup steps
1. Set `DATA_ENCRYPTION_KEY` (32+ random characters) in production before saving any secret. If it is not set, `JWT_SECRET` is used and rotating it makes stored secrets unreadable (re-enter them).
2. Console > Integrations > Email: enter host, port, security, login, From address; Save; **Verify connection**; **Check sender**; send a test email to yourself; press **It arrived**; switch email on.
3. Console > Integrations > SMS: leave on Test until the provider approvals exist.

## Deploy and roll back
New collections: `platformsettings`, `integrationlogs`, `phoneotps` (created on first use; no migration needed). New dependency: `nodemailer`. Roll back by redeploying the previous build; the collections are ignored by older code and email falls back to the environment provider.

## Not built
POP3/IMAP (EduAmigo does not read any mailbox), per-school email or SMS settings, phone-code sign-in for school users.


---
# Security review (2026-10-24)

## Environment variables
| Variable | Needed | Purpose |
|---|---|---|
| `DATA_ENCRYPTION_KEY` | **Production: required, at least 32 random characters.** Saving a password or API key is refused (503) without it | encrypts saved secrets and keys the phone-code hashes |
| `JWT_SECRET` | existing | used for the encryption key only when `DATA_ENCRYPTION_KEY` is absent (not allowed for saving secrets in production) |
| `NODE_ENV=production` | production | turns on: no unencrypted SMTP, key required |
| `ALLOW_PRIVATE_SMTP_HOSTS` | **never in production** | local development only: lets the console talk to a mail catcher on a private address and relaxes certificate checks |
| `INTEGRATION_TESTS_PER_15_MIN` | optional (default 30) | limit for provider-contacting actions per owner account |
| `EMAIL_PROVIDER`, `EMAIL_FROM`, `BREVO_API_KEY`, `RESEND_API_KEY` | optional fallback | used when no saved SMTP settings are switched on |

Never put the SMTP password or an SMS key in an environment file for this feature: they are entered in the console and stored encrypted.

## Findings and what was done
| Area | Finding | Result |
|---|---|---|
| SMTP network guard | The first version judged IPv6 mapped addresses written in hex (`::ffff:7f00:1`) as public | **Fixed**: now uses Node's `BlockList` (IPv4, IPv6, mapped, carrier NAT, link-local, documentation, multicast, reserved); tested with 15 address spellings and the names `localhost`, `127.1`, `2130706433`, `0x7f.1` |
| DNS rebinding | The name is resolved once, every address is checked, and the connection goes to the checked address; the certificate is validated against the original name | Reviewed and covered by tests of the address check. A live rebinding attack against a real DNS server was **not** performed |
| Redirects | SMTP has no redirects. The SMS adapters now set `maxRedirects: 0` so an HTTP redirect cannot carry a key to another host | Fixed and tested |
| Port scanning | Ports are limited to 25, 465, 587 and 2525, so the form cannot probe other services | In place |
| Key handling | A key change makes saved secrets unreadable | **Added**: the console reports it ("enter it again") instead of a misleading login error; tested by rotating the key mid-test |
| Production key | Without `DATA_ENCRYPTION_KEY` the key came from `JWT_SECRET` | **Added**: refused in production |
| Secret rotation | There is no key version or automatic re-encryption; rotating the key means re-entering each secret in the console | Known limitation |
| OTP | 6 random digits, keyed hash, expiry, single use, 5 attempts, per-phone cooldown and hourly cap; two simultaneous requests could both pass the cooldown | **Fixed**: the earlier request wins, the other is withdrawn (tested) |
| OTP guessing | At most about 25 guesses per phone per hour with defaults (5 codes x 5 attempts) against 1,000,000 codes | Acceptable; lower `maxAttempts` or the hourly cap to tighten |
| Authorization | All routes sit behind the platform token and the `superadmin` role; a school token is refused; settings are platform-wide so there is no tenant data to cross | Tested |
| Audit and logs | Provider text could echo an address or number | **Fixed**: addresses and numbers in error text are masked; secrets are replaced; logs and audit hold no code or message body |
| Test mode safety | A saved real provider in production mode but switched off would still have sent | **Fixed**: a message leaves the server only if SMS is switched on in production mode, or the owner ticks "Send a real SMS" for that one request. Tested that neither test mode nor "switched off" calls the provider |
| Production enablement | Production could not be reached (it needed an accepted real send, which test mode never makes) | **Fixed**: the explicit real-send option provides it; production requires one accepted real send first |
| nodemailer | 6.9.16 had a high-severity advisory list (address parsing, SMTP command injection, TLS server-name cache) | **Upgraded to 10.2.1** (latest, needs Node 20+); `npm audit --omit=dev` no longer lists nodemailer |

## Provider adapters: code review versus live verification
- **Twilio** (checked against Twilio's Message resource documentation): `POST /2010-04-01/Accounts/{sid}/Messages.json`, form fields `To`, `From`, `Body`, HTTP Basic with account SID and auth token. Matches. Notes: an API key and secret also work as credentials; `MessagingServiceSid` is not supported by this adapter; whether an alphanumeric `From` is accepted depends on the destination country (not verified for India).
- **MSG91**: the official reference page could not be retrieved in this review. The adapter follows third-party descriptions of the v5 OTP API (`POST https://control.msg91.com/api/v5/otp`, query `template_id`, `mobile` with country code and no plus sign, `otp`, `otp_expiry` in minutes). Where the `authkey` goes (header or query) is **unconfirmed**; the adapter sends it as a header. Check against docs.msg91.com before the first live send.
- **Live verification: none.** No real credentials were used and no provider was contacted.

## Safe setup order
1. Set `DATA_ENCRYPTION_KEY` and restart. 2. Console > Integrations > Email: save, Verify connection, Check sender, send a test email to yourself, "It arrived", switch on. 3. SMS: stay in Test mode; after DLT/template approval, save credentials, tick "Send a real SMS" once to your own number, then switch to Production and on.

## Rollback
Switch each integration off in the console (email falls back to the environment provider; SMS simulates). To remove the feature, redeploy the previous build; `platformsettings`, `integrationlogs` and `phoneotps` can stay or be dropped. If `DATA_ENCRYPTION_KEY` is changed, re-enter the secrets.

## Known limitations
No key versioning; no per-school settings; phone codes are not wired to any school sign-in; MSG91 header placement unconfirmed; real delivery unverified; DKIM is not checked automatically; the delivery log keeps 90 days.

**Dependency audit (backend, production dependencies, 2026-10-24):** 10 findings (8 moderate, 2 high). None is nodemailer any more. The two high ones are `body-parser` (2.0.0 to 2.3.0) and `multer` (2.0.0 to 2.4.0) denial-of-service advisories that were not in the earlier audit (published since); the moderate ones are the long-known `firebase-admin` chain. `npm audit fix` is offered for the two high ones but was not applied here because it changes existing upload and body parsing, which needs its own test run.

---
# Owner console operations (2026-10-24)

Routes under `/api/platform` (platform token, `superadmin` only) added with the console redesign. Code: `controllers/platformOpsController.js`, `models/PlatformNotice.js`, `models/SupportRequest.js`, `routes/supportRoutes.js` (school side).

| Area | Routes | Notes |
|---|---|---|
| Overview | `GET /analytics?months=` | schools added and paid revenue per month, status mix, outstanding amount, attention list (trials ending in 7 days, overdue invoices, open support requests, suspended and read-only schools). Real counts only |
| Platform accounts | `GET/POST /users`, `PATCH /users/:id`, `POST /users/:id/reset-password` | strong password required (8+, letters and numbers); the password is never returned or logged; switching someone off or resetting a password signs them out everywhere (`tokenVersion`); you cannot switch yourself off and the last active account cannot be switched off; school emails cannot be reused |
| Announcements | `GET/POST /notices`, `POST /notices/:id/archive` | shown to administrators, accountants and office staff on the school dashboard while live (`GET /api/support/notices`) |
| Support requests | owner: `GET /support`, `GET/PATCH /support/:id`; school: `GET/POST /api/support/requests`, `POST /api/support/requests/:id/reply` | a school sees only its own requests and EduAmigo's public replies; internal notes never leave the console; needs `settings.manage` in the school; 20 open requests per school at most |
| Settings | `GET/PUT /settings` | organisation name, support contacts, console session length (1 to 24 h, used at the next sign-in) |

New collections: `platformnotices`, `supportrequests` (created on first use). No migration. Rollback: redeploy the previous build; the console pages disappear and school offices lose the banner and the Help and support page.

Not built: partial platform roles (everyone on the team has full console access), per-school announcements, email notification of support replies, a status page.
