# UnifiedAI in EduAmigo ("EduAmigo Ask"): architecture

UnifiedAI is the single assistant of EduAmigo (Microsoft Innovate 2026, PS-18 "One Front Door for Everything"). In the
code and the product it is called **EduAmigo Ask**: backend `src/assistant/`, API `/api/assistant`, button on every portal
screen. A person asks in their own words (English, Hindi or Hinglish, several topics at once) and the assistant answers
from the school's own records and documents, asks when unsure, or hands the matter to a named person.

```
person -> Ask button (every screen) -> POST /api/assistant/ask
  guard        signed in, plan has ai_assistant, per-user rate limit, monthly AI allowance
  choice       a tapped button resumes the question that was waiting
  safety       unambiguous safety words (exact spelling) go to a person at once, whatever the model says
  understand   ONE model call reads the whole message: separate questions, topic, kind, child, class, subject,
               person, "about whom", exam view, language, restatement in plain English, confidence
  reconcile    the model's reading is checked against weighted keywords; ties are asked, never guessed
  gate         confidence >= 0.75 answer | 0.45-0.75 clarify between two topics | below: topic menu + office
  scope        the asker may only see their own / their children's / their classes' records (server decides)
  access       role may use the topic, school plan includes it
  details      which child, student, class, teacher (asked when missing)
  skill        reads the school's records or documents, returns facts, sources, screen link
  compose      the model writes the answer to the exact question from the facts; numbers and names are checked
  forward      a question only a person can answer becomes a ticket for the named teacher / office
  log          redacted question, topic, confidence, action, sources, composition, latency, model use
person <- reply (typed out word by word) + source cards + buttons
```

Without a model (not configured, allowance used, failure, timeout) the keyword router and the standard English answers do
the same work, so the assistant degrades instead of failing.

## One front door

`router.understand` returns one entry per question in the message ("fees kitni baki hai aur kal ka timetable" gives two),
each routed on its own, answered on its own, in one reply bundle. Nothing in the UI asks the person to pick a department.
Clarifying buttons appear only when the topic or the child is really ambiguous.

## Domains and skills

A domain (`domains.js`) has a label, a one-line description for the model, the roles allowed, the plan feature required,
the hand-off owner, and fallback keywords. Each domain has one skill (`skills/*.js`) that reads only its own collections,
always filtered by `school`, and returns `{ text, facts, sources, link, actions }` or `{ need }` (ask which class),
`{ noData, handoffOffer }`, `{ blocked }`.

| Domain | Source of truth | Who |
|---|---|---|
| fees | `Fee` (amount, payments, receipts) | student, parent, admin, accountant |
| attendance | `Attendance` | student, parent, teacher, admin |
| timetable | `Timetable`, `Teacher` | student, parent, teacher, admin |
| exams | `ExamSchedule`, `ExamResult` (published only) | student, parent, teacher, admin |
| notes | `Note` (homework, assignments, study material) | student, parent, teacher, admin |
| transport | `Transport` (bus, route, live stop) | student, parent, admin |
| notices | `Announcement`, `Event` | every role including accountant |
| leave | `LeaveRequest` | student, parent, teacher, admin |
| library | `Library` (catalogue; borrowers are not recorded) | student, parent, teacher, admin |
| admissions | `Admission` | admin |
| hr | `Salary`, `StaffLeave` | teacher (own), admin |
| **policies** (School information) | `SchoolDocument`: handbook, policies, FAQs added by the admin | everyone |
| general | greetings, thanks, general knowledge (a short model answer, never about the school) | every role |

Documents are the knowledge-retrieval half of PS-18: rules, timings, uniform, refund and leave policies, exam rules. The
admin adds them in Admin > EduAmigo Ask > School documents (pasted text or PDF). They are split into sections at
headings, searched with BM25 over the school's own sections (restricted by audience: a staff-only document is never used
for a parent), and an answer cites the document, the section, the quoted passage and the date it was last updated. A
question the documents do not answer is told so and offered to the office; it is never guessed.

## Routing and confidence

* **Understanding.** One model call (`temperature 0`, JSON only). Output fields are validated: unknown topics are dropped,
  confidence is clamped to 0..1, strings are length-limited, `child` and `person` are only ever used to *look up* real
  records, never trusted as data.
* **Reconcile** (`router.reconcile`): (1) two topics tie on the words and the message is short: the tie decides and the
  person is asked; (2) the model found no school topic but the words clearly name one: the words win; (3) model and words
  agree: confidence is the higher of the two; (4) one or two words with no topic word: asked.
* **Signals behind confidence** (returned as `signals`): the model's own confidence, the keyword score (strength times
  margin over the runner-up), and whether they agree. The reported number is the model's confidence, raised when the words
  agree.
* **Meaning of the number.** It is only worth what it predicts, so it is *measured*: the evaluation groups questions by
  reported confidence and shows how many each group got right, with the calibration error (ECE). See `EVALUATION.md`. The
  thresholds (answer 0.75, clarify 0.45) are environment-tunable (`ASSISTANT_ANSWER_AT`, `ASSISTANT_CLARIFY_AT`).
* **Gate.** answer / clarify between two topics / topic menu with "ask the school office". A third unclear attempt in a row
  becomes a ticket.

## Context across a conversation

`AssistantConversation.state` keeps only what is needed: last topic, last child, last class, and the one pending question
(with its options). The model is told only the previous topic and the asker's children, never the transcript. "Aur Riya
ki?" and "uski attendance?" resolve through that state. A new chat clears it. Conversations expire after 7 days.

## Grounding, in order of strength

1. **Facts come from the database**, scoped by school and by the asker. The model never supplies a fact.
2. **The composer** (`compose.js`) writes the sentence. Every number must appear in the facts, the standard answer or the
   question; every name (capitalised word) must too. Otherwise the standard answer is shown (`composition: kept_original`).
3. **Missing information is stated.** If the facts do not contain what was asked, the composer says what the records do
   show and the person is offered the right teacher by name.
4. **Sources are real.** Every answer lists the records it read (type, label, id, last-updated time); document answers add
   the quoted evidence.

Details and limits in `AI_GROUNDING.md`.

## Authorization

The model never decides access. `ask` runs inside `protect` (JWT, active user, school entitlements). Every skill filters
by `ctx.schoolId`. A parent's students are `childrenForParent`; a student's is `studentForUser`; a teacher is limited to
assigned classes (`teacherCoversClass`); named students are checked with `canAccessStudent`. `scopeRefusal` (engine.js)
refuses, with a clear message, a question about another student or "everyone" for personal records, and a teacher's
question about someone else's salary. Tapped choices are re-validated server-side. See `SECURITY.md`.

## Hand-off

Reasons: `sensitive` (urgent, always includes admins), `complaint`, `requested` (asked for a person), `forwarded` (only a
person can answer), `unclear`, `not_covered`. Recipient: a teacher the person named, else the subject's teacher for the
child's class (from the timetable), else the child's class teacher, accountants for fees, otherwise the school office.
The reply names the person ("sent to Anita Verma (Maths teacher), ticket T-1004"), the ticket carries a short summary so
nobody has to explain twice, the assignees are notified, and the sender is notified when it is resolved. Tickets are
listed under Requests in the chat and in the admin dashboard. "Has the school sent a complaint about me?" is a question
about records, not a complaint: it is answered, and a ticket is only made if the person agrees.

## Observability

Every question is logged (`AssistantQuery`, text redacted of phone numbers, emails and ID numbers): topic, confidence,
runner-up, method, action, number of sources, whether the answer was grounded, composition outcome, latency, model, token
use, feedback. `GET /api/assistant/metrics` and the admin dashboard show: questions, answered / clarified / handed-off
rates, **end-to-end resolution** (see `EVALUATION.md`), source coverage, share of model-written answers that failed the
fact check, speed (p50, p95), model use, topics, and what needs attention. Nothing sensitive beyond the redacted question
text is logged, and API keys are never logged.

## Reliability

* Model calls: 6 s timeout, one retry on rate limit, provider fallback (Azure then Gemini), a 60 s cool-off after three
  failures, 10-minute answer cache. Any failure falls back to keywords and templates.
* Rate limit: 120 questions per user per hour; per-school monthly allowance for model-assisted questions.
* Malformed model JSON, unknown topics and nonsense confidence are ignored (tested).
* Understand and compose/reword calls run in parallel where possible; typical latency 2 to 3 s with the model.

## Interface

A round button on every portal screen opens a panel that fills the app frame (phone) or a side panel (admin desktop). It has
a bot avatar, a typing indicator, replies revealed word by word (the server sends the whole answer at once; the reveal is
on the screen), source cards with quoted evidence for documents, choice buttons for clarification, a Requests tab for
tickets, thumbs up or down, and a "New chat". Technical details (topic, confidence) are only shown to staff with
`assistant.insights`. Admin > EduAmigo Ask has the metrics, the evaluation, tickets, and the School documents tab.
