# Database architecture

MongoDB through Mongoose, 43 models in `src/models` (the table of references is in `PROJECT_UNDERSTANDING.md`, generated from
the code). Rules that hold everywhere:

* every tenant document has `school` (ObjectId, required); indexes start with `school`;
* ids from requests are validated before use; regexes built from user input are escaped (`escapeRegex`);
* money is stored as numbers in rupees; dates that mean a school day are midnight UTC of the Indian date (`utils/dates.js`).

## Where the truth lives

| Fact | Authoritative record |
|---|---|
| Who a parent's children are | **Two places**: `Student.parentUserId` and `Parent.children`. `services/directory.js` reads both, so every feature agrees. This duplication is historical and is a known weakness: a future migration should keep one |
| A student's login | `Student.userId` -> `User` |
| Fees owed and paid | `Fee` (`amount`, `paidAmount`, `payments[]` with receipt numbers) |
| Published marks | `ExamResult` (written only when marks are published; `Mark` holds drafts) |
| Attendance | `Attendance` (one row per student per day) |
| Timetable | `Timetable` (one document per class, section and weekday) |
| Plans and add-ons | `Plan`, `AddOn`, `School.subscription`, `UsageCounter` |
| Audit | `AuditLog` |

## EduAmigo Ask collections

| Model | Purpose | Notes |
|---|---|---|
| `AssistantConversation` | context of one chat (last topic, child, class, the pending question and its options) | TTL: deleted after 7 days of inactivity |
| `AssistantQuery` | log of each question and its parts: topic, confidence, method, action, sources, grounded, composition, ticket, latency, model, feedback | question text redacted; indexed by `school, createdAt` and `school, user, createdAt` |
| `AssistantTicket` | hand-off ticket T-1001...; reason, priority, team, assignees, `contacts` (who it was sent to, by name), short summary, status, notes | numbers from `Counter` per school; unique index `school, number` |
| `SchoolDocument` | handbook, policy, FAQ: title, category, audience, sections `[ {heading, text} ]`, version, active | max 60 per school; index `school, isActive` |

No parallel store was created: the assistant reads the existing collections and adds only the four above. Embeddings are not used
for school documents (a school has a few dozen); the AI Revision feature keeps its own `NoteEmbedding` with Atlas Vector Search.

## Migration and seed

`npm run migrate` brings an older database to the current shape (admission numbers, school code, plan). `npm run backup` writes a
read-only copy of the live database to `backups/` (git-ignored; contains real personal data). `npm run demo` seeds three demo
schools with a month of activity, plus the Allied International School pair; `--from-backup` loads the copy as Allied
International School, Gaya.
