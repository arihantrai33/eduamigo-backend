# UnifiedAI in EduAmigo ("EduAmigo Ask"): architecture

UnifiedAI is the single assistant of EduAmigo (Microsoft Innovate 2026, PS-18 "One Front Door for Everything"). In the
code and the product it is called **EduAmigo Ask**: backend `src/assistant/`, API `/api/assistant`, button on every portal
screen. A person asks in their own words (English, Hindi or Hinglish, several topics at once) and the assistant answers
from the school's own records and documents, asks when unsure, or hands the matter to a named person.

```
person -> Ask button (every screen) -> POST /api/assistant/ask
  Gateway      signed in, plan has ai_assistant, per-user rate limit, monthly AI allowance, school scope (RBAC)
  Trace        request id; each step below records its time and outcome (never the message text)
  choice       a tapped button resumes the question that was waiting
  safety       unambiguous safety words (exact spelling) go to a person at once, whatever the model says
  Conversation Manager
               recent turns (6, redacted), people and tickets just mentioned, last topic/child/class, the person's own recent tickets
               -> a compact context for the model (never the whole transcript)
  AI Orchestrator (understand)
               ONE model call reads the message with that context: separate parts, topic, kind, child, class, subject, person,
               "about whom", exam view, language, plain-English restatement, safety category, how the message relates to the
               person's tickets, a staff brief, confidence
  reconcile    the model's reading is checked against weighted keywords; ties are asked, never guessed
  gate         confidence >= 0.75 answer | 0.45-0.75 clarify between two topics | below: topic menu + office
  scope        the asker may only see their own / their children's / their classes' records (server decides)
  access       role may use the topic, school plan includes it
  per part:
    question   Domain skill reads records or the school's documents -> facts + sources (Knowledge / RAG)
               -> compose: the model writes the answer from the facts; numbers and names are checked
    needs a person
               Action Planner -> action contract (authorize, validate, execute) -> Action Verifier -> reply from the VERIFIED result
               Safety/Policy decides priority and escalation; Handoff chooses the recipients and writes the staff brief
  Response     put into the person's language (writer), name and number guards
  log          redacted question, topic, confidence, action, sources, trace steps, action log, latency, model use
person <- reply (typed out word by word) + source cards + ticket card + buttons
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

## Conversation Manager (`conversation.js`)

Short-term state only, in `AssistantConversation.state`: the last six turns (phone numbers, e-mails and ID numbers redacted, 240
characters each), up to five people and three tickets just talked about, the last topic, child and class, and the one pending
question with its options. Nothing permanent about the person is kept; the state expires with the chat (7 days).

What the model sees is built by `contextFor`: the recent turns, the people just mentioned, and the person's own recent tickets
(30 days, five at most). The ticket raised or discussed in this chat is listed on its own ("THIS chat"), apart from the other
tickets, because mixed together it gets lost and the model picks another ticket of the same teacher. The model uses this to resolve
"him", "that issue", "same as before", "still not fixed"; a ticket number or a name not in the context must never be invented, and
the server also rejects any ticket that is not the person's own.

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

## Actions: planner, contracts, verification, policy

A message that needs a person (complaint, request to speak to staff, a question only a person can answer, a safety concern) does
not blindly open a ticket.

1. **Finding the ticket.** The person's recent tickets (30 days, five at most) plus the ones discussed in this chat are given to the
   model and the planner. A ticket number the person types is looked up directly by number, school and owner, whatever its age
   (`conversation.ticketByNumber`); a number only the model named is used only if it is the person's own. Someone else's ticket
   and a number that does not exist give the same answer ("I could not find a ticket T-... among your requests"), so nothing is
   revealed, and nothing is created or attached. Someone who has raised nothing and asks "what happened to my complaint" is told
   that plainly.
2. **Planner** (`planner.js`). The model says how the message relates to the person's tickets: `new`, `follow_up`, `repeat`,
   `escalate`, `reopen` or `status`, and may name a ticket. The planner checks the claim against the real tickets: the ticket
   must be the person's own, and must not contradict the message (another topic, child, named person or subject). An
   incompatible claim is overruled. With no usable claim a similarity rule applies (same topic, child, subject, person, at least
   40% shared words, open, within 14 days). "New" is not believed for a ticket that was just created in the same request. With
   no ticket named, a status question is about the ticket discussed in this chat. A repeat or follow-up on a resolved ticket is a
   reopening (within 14 days), never an "open ticket".
3. **Action contract** (`actions/`). Each action (`ticket.create`, `follow_up`, `repeat`, `escalate`, `reopen`, `status`) has
   authorize, validate, execute and verify steps (and, for create, `recover`). `run()` never throws and returns a `state`:
   `denied` and `invalid` (nothing ran), `not_executed` (failed before changing anything, confirmed by looking), `error` (failed
   part-way and nobody can tell whether it was saved), `unverified` (it ran, the read-back did not confirm it) and `verified`.
   The language model only proposes; the backend decides and does.
4. **Idempotent creation.** A ticket carries a key made from school, person, child, normalised wording and a two-minute window
   (the previous window is checked too), backed by a unique index. Two requests that arrive at the same moment create one ticket;
   the second gets the first back, creates nothing and notifies nobody again. If creating fails after the ticket was saved, the
   ticket is found again and reported instead of being created a second time.
5. **Verification and honest replies** (`actions/messages.js`). The reply is chosen from the state. Verified: "added to your
   existing ticket T-1002", "sent to Anita Verma (Maths teacher), ticket T-1004". Not executed or invalid: "nothing was changed",
   with a Try again button (safe, because nothing exists and creation is idempotent). Unverified or unknown: "I could not confirm
   that it was recorded completely / I cannot tell whether it went through; check Requests before asking again", no button, so a
   retry cannot double it. A failed notification is reported as such. Someone else's ticket number gets a refusal.
6. **Policy** (`policy.js`). Priority is not the model's to give. The model's safety label (`harassment`, `medical`, `safety`,
   `payment_dispute`) is an unconfirmed signal that the person's text can try to steer. High priority comes from (a) safety words
   the person really wrote, found after instructions aimed at the assistant ("SYSTEM NOTE", "ignore previous instructions",
   "classify this as ...") are cut out of the text, (b) the person escalating their own ticket once, or (c) a model label that
   the message itself confirms: its own words match that category's word list, or a separate check quotes the person's words and
   the quote is verified to be in the message. A label nothing confirms stays on the ticket as "model-asserted, unconfirmed"
   (staff see it in the priority reason and the notification), the priority stays normal and the admins are not brought in. A
   ticket that is not urgent by policy is not described as urgent to the person. Limits: the word lists are a floor, not a
   classifier; a real emergency worded outside them and missed by the second check is under-prioritised (staff still see the
   flag); and a person can still escalate their own ticket by asking, which is intended. A resolved ticket can be reopened for 14 days.
7. **Handoff** (`handoff.js`, router brief). Recipients: a teacher the person named, else the subject's teacher for the child's
   class (timetable), else the class teacher, accountants for fees, otherwise the school office; admins are added when priority is
   high. Staff see a short professional English brief (title, summary, request) and the person's own words (kept for audit, with
   phone numbers, e-mails and ID numbers replaced by placeholders); the language of the brief is asked of the model, not
   enforced by code. The assignees are notified; the sender is notified when it is resolved. Tickets are listed under Requests
   in the chat and in the admin dashboard.

**Without a model** (provider down, allowance used) a short message that asks about an existing complaint or ticket ("meri
complaint ka kya hua", "T-1004 ka status", "complaint pe abhi tak kuch nahi hua") only reads the person's own ticket (the one
named, else the one just discussed, else the newest); it never creates a ticket or adds a note. A clearly new complaint and safety
words still become tickets. A bare "abhi tak kuch nahi hua" with no ticket reference is not treated as a complaint at all.

**Unconfirmed actions.** When an action ran but could not be read back, the person is told it was attempted and the final result
could not be confirmed (no internals, no retry button, ticket card labelled "not confirmed"). The ticket is marked
`verification: unverified` (shown to staff as `needsReview`, never to the person who raised it; cleared when a person handles it
or the action is later confirmed), the trace and the action log record the state and the failed checks, and sending the same
message again finds that ticket however much later (and, if someone can be reached by then, finishes the job) instead of creating another.

"Has the school sent a complaint about me?" is a question about records, not a complaint: it is answered, and a ticket is only
made if the person agrees.

## Observability

Every request that completes is logged (`AssistantQuery`; a request that throws before the end is not, see the audit findings), text redacted of phone numbers, emails and ID numbers): topic, confidence,
runner-up, method, action, number of sources, whether the answer was grounded, composition outcome, latency, model, token
use, feedback. `GET /api/assistant/metrics` and the admin dashboard show: questions, answered / clarified / handed-off
rates, **end-to-end resolution** (see `EVALUATION.md`), source coverage, share of model-written answers that failed the
fact check, speed (p50, p95), model use, topics, and what needs attention. Nothing sensitive beyond the redacted question
text is logged, and API keys are never logged.

Each request has a request id (`trace.js`, returned in the response and stored on the query) and a list of steps with milliseconds
and outcome: `understand` (provider, cached, number and kinds of parts, fallback), `route`, `plan` (the model's relation and
ticket, the planner's action, how it decided, how many tickets), `action:*` (executed, verified, denied and why) and `respond`.
`ASSISTANT_LOG=json` prints one JSON line per request with these steps, without the message text.

## Reliability

* Model calls: 10 s timeout (`ASSISTANT_TIMEOUT_MS`), one retry on rate limit (capped at 4 s), provider fallback (Azure then Gemini), a 60 s cool-off after three
  failures, 10-minute answer cache. Any failure falls back to keywords and templates.
* Rate limit: 120 questions per user per hour; per-school monthly allowance for model-assisted questions.
* Malformed model JSON, unknown topics and nonsense confidence are ignored (tested).
* Understand and compose/reword calls run in parallel where possible; typical latency 3 to 5 s with the model (understanding is about 2 s, writing about 1.5 s).

## Interface

A round button on every portal screen opens a panel that fills the app frame (phone) or a side panel (admin desktop). It has
a bot avatar, a typing indicator, replies revealed word by word (the server sends the whole answer at once; the reveal is
on the screen), source cards with quoted evidence for documents, choice buttons for clarification, a Requests tab for
tickets, thumbs up or down, and a "New chat". Technical details (topic, confidence) are only shown to staff with
`assistant.insights`. Admin > EduAmigo Ask has the metrics, the evaluation, tickets, and the School documents tab.
