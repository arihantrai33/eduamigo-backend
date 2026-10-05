# UnifiedAI: current state (verified against the code, 2026-10-06)

This describes what exists on branch `feature/eduamigo-ask` (backend and frontend), not what is planned. Where something is
only partly done it says so. Nothing is deployed and there is no production traffic; every number below comes from tests or
from runs against the local demo school (in-memory database), not from real users.

## 1. What UnifiedAI is in this codebase

One assistant ("EduAmigo Ask") for a school: a parent, student, teacher or admin asks in English, Hindi (Devanagari) or Hinglish,
and gets an answer from the school's own records and documents, a clarifying question, or a ticket to a named person.
Backend `src/assistant/`, API `/api/assistant/*`, button on every portal screen in `eduamigo-frontend`.

## 2. Request flow as implemented

```
POST /api/assistant/ask                                     (engine.js: ask)
  guard           JWT, plan feature ai_assistant, per-user rate limit, monthly AI allowance
  trace           request id and step timings start (trace.js)
  choice          a tapped option resumes the waiting question (re-validated on the server)
  safety words    exact-spelling emergency words go to a person at once
  understand      ONE model call (router.understand): parts, topic, kind, child, class, subject, person, about whom,
                  exam view, language, English restatement, search synonyms, safety category, ticket relation, staff brief.
                  Input: the message + compact context (conversation.contextFor). Not the whole transcript.
  reconcile       model reading checked against weighted keywords; real confidence; ties are asked, never guessed
  gate            >= 0.75 answer | 0.45 to 0.75 clarify | below: topic menu and the office
  scope refusal   other student / everyone / another person's salary: refused with a message (server decides)
  access          role may use the topic; plan includes it
  per part:
     question     skill (skills/*.js) reads records or school documents -> facts + sources -> compose.js writes the
                  answer, numbers and names checked against the facts
     needs person ticketReply -> planner.plan -> actions.run (authorize, validate, execute, verify) -> messages.describe
  write           reply put into the person's language (writer.js); name and number guards
  log             AssistantQuery (redacted question, topic, confidence, action, sources, trace steps, action log, request id)
```

Without a model (not configured, allowance used, failure, timeout) the keyword router and standard English answers do the
same work. This degraded path is weaker, see the limitations.

## 3. Components, with files

| Component | What it does | Files |
|---|---|---|
| Gateway (auth, RBAC, plan, rate limit) | `protect`, `requireFeature('ai_assistant')`, permission `assistant.*`, school scoping on every query | `routes/assistantRoutes.js`, `middleware/`, `config/permissions.js` |
| Conversation Manager | last 6 turns (redacted, 240 chars), people (5), tickets (3), last topic/child/class, one pending question; compact context for the model; the person's own recent tickets (30 days) | `conversation.js`, `models/AssistantConversation.js` |
| Understanding (NLU) | one structured model call; English/Hindi/Hinglish; coreference ("him", "that issue") resolved from context; invented ticket numbers and names rejected | `router.js` |
| Routing and confidence | model-first, keyword reconcile, calibrated confidence, clarify / handoff fallback | `router.js`, `engine.js`, `eval.js` |
| Multi-intent | one message may hold several questions or one question plus a complaint; parts handled independently; a failed part does not lose the others; one issue told as several sentences stays one ticket | `engine.js` (`mergePersonParts`), `router.js` |
| Domain skills | 12 domains, each reads its own records; school documents as a 13th source | `skills/*.js` |
| Grounding / RAG | facts from the database; BM25 retrieval over the school's documents (sections, audience filter, version/date); composer checks numbers and names; sources and quoted evidence on every answer | `compose.js`, `services/knowledge.js`, `models/SchoolDocument.js` |
| Action planner | maps the model's reading of how a message relates to the person's tickets (new, follow_up, repeat, escalate, reopen, status) to an action; validates ownership; overrules incompatible claims (other topic, child, person or subject); similarity fallback; "new" not trusted for a ticket just made in this request | `planner.js` |
| Action contracts | `ticket.create / follow_up / repeat / escalate / reopen / status`: authorize, validate, execute, verify; `run()` never throws; reply is built only from the verified result | `actions/index.js`, `actions/ticketActions.js`, `actions/messages.js` |
| Policy | priority is decided from safety category (not by the model, not by the word "urgent"); one escalation; reopen window 14 days | `policy.js` |
| Handoff | recipients: named person > subject teacher (timetable) > class teacher > accountants > office; admins added when priority is high; professional English brief (title, summary, request) for staff; the person's original text kept for audit | `handoff.js`, `models/AssistantTicket.js` |
| Safety | prompt-injection tests, model output validated (unknown topic, nonsense confidence ignored), no secrets in logs, redaction of phone/email/ID | `assistant-security.test.js`, `text.js` |
| Provider layer | Azure OpenAI first, Gemini fallback, timeout (10 s default), capped 429 retry, 60 s cool-off after 3 failures, answer cache | `llm.js` |
| Observability | request id; trace steps (understand, route, plan, action, respond) with timings, no message text; optional JSON log line (`ASSISTANT_LOG=json`); admin dashboard | `trace.js`, `models/AssistantQuery.js`, `metrics.js` |
| Evaluation | routing eval (290 questions), answer eval (125 questions + 12 chats + 8 fresh chats), calibration, saved reports read from disk by the dashboard | `eval.js`, `scripts/assistantEval.js`, `scripts/assistantAnswerEval.js`, `eval/*.json` |
| UI | chat with avatar, typing indicator, word-by-word reveal, source and evidence cards, ticket card (number, status, who), Requests tab with timeline, admin insights and School documents | `eduamigo-frontend/src/components/AskWidget.jsx`, `pages/admin/AskInsights.jsx`, `AskKnowledge.jsx` |

## 4. Ticket lifecycle as implemented

New report -> `ticket.create`. The same issue told again, or a nudge ("still nothing") -> `ticket.follow_up` or `ticket.repeat`
on the existing ticket, with a clear message ("added to your existing ticket T-1002"), no second ticket. "Take it higher" ->
`ticket.escalate` once (priority high, admins added), a second request is told it is already urgent. Resolved within 14 days and
the problem is back -> `ticket.reopen`; older -> a new ticket. "What happened to my complaint" -> `ticket.status`, which prefers
the ticket discussed in this chat. A ticket number that is not the person's own is refused (`not_yours`). If the database write
or the notification fails, the reply says so and offers "Try again"; success is never claimed unverified.

## 5. What was verified (and how)

| Claim | Evidence |
|---|---|
| Automated tests | 570 tests in 28 suites pass (`npx jest`, 2026-10-06). 23 of them in `assistant-conversation.test.js` cover memory, planner, action verification, provider failure, trace. |
| Routing accuracy | `npm run assistant:eval -- --model --save`, 290 labelled questions: overall routing 95.5%, action 97.6%, both 95.2%; holdout 92.5% both; unseen 93.3%; fresh (40) 97.5%. ECE 0.02. Model and keywords agree: 98.7% right (227); disagree: 70.6% (34). |
| Answer accuracy | `assistantAnswerEval.js --save` on a fresh demo: 125/125 single questions (100%) and 11/12 multi-turn chats. The 125 set was repaired until it passed; it guards against regressions and is not an accuracy estimate. |
| Honest accuracy on unseen questions | final untouched batch of 20 questions: 19/20 (95%) before the stemmer fix; 30 questions written after the fixes pass 30/30 (the saved "fresh" line); 8 new conversations (`final2`) 8/8 on a fresh demo. |
| Lifecycle chats | 12/12 conversations on three separate fresh demo states after the last changes; 8/8 on `final2` on two fresh states. |

### Evaluation results that are not clean, stated plainly
* **The saved full run shows 11/12 chats.** The failing chat ("ticket lifecycle") sends a complaint about Riya's science marks.
  In a combined run, an earlier single question in the same demo database had already created a ticket for the same child, subject and
  teacher on the same day, so the assistant correctly said "added to your existing ticket" instead of creating a new one. The
  test expects a new ticket. This is demo-data coupling between two parts of the evaluation, not a product error; on a fresh
  database the same chat passes (12/12 three times). The expectation was not changed.
* **Model variance.** Real-model runs are not perfectly repeatable: in four combined runs one other chat failed once ("unko bhi
  bol do" created a new ticket instead of following up) and in one fresh run an escalation message was answered as a general
  question. Both were traced; the model returned a different reading than in 18 isolated probes. The first was fixed (the
  current chat's ticket is now listed on its own in the context, and the prompt says how to treat it); the second was not
  reproduced again in three further fresh runs and is not claimed fixed.
* **Infrastructure effects seen:** one Azure call exceeded the timeout and the keyword fallback answered a complaint as a
  question (graceful degradation, wrong outcome); a sleeping laptop once produced absurd latencies in an earlier session.

## 6. Defects found in this phase and fixed (each has a regression test)

| Defect | Cause | Fix |
|---|---|---|
| "what time does school start in the morning" answered "not in the documents" | the stemmer kept "time" and "timing" apart; a stray word ("start") matched the refund section | stemmer joins them (final "e", "ing" with 3-letter stem) |
| model attached a new message to an unrelated ticket | claim not checked | `planner.compatible()` (topic, child, person, subject) |
| ticket claim rejected, then similarity fallback attached it to the same ticket anyway | similarity ignored the subject | similarity respects subject |
| "unko bhi bol do" lost among 5 tickets | context did not separate the current chat's ticket | `contextFor` lists "THIS chat" ticket on its own; prompt rule |
| "meri complaint ka kya hua" answered for the newest ticket, not the one discussed | status fallback ignored the chat | planner prefers the chat's ticket |
| a document answer cited passages that were not used | citations took the top hits | composer returns `used` passage numbers |
| batch mode printed "0/0 answers correct" and a partial run could overwrite the full saved report | reporting | summary only when singles ran; `--save` ignored with `--batch` or a filter |

## 7. Known limitations (current)

* Latency is about 3 to 5 s per message (understand call and writing call); answers are not streamed from the server.
* Voice input is not implemented.
* Document retrieval is lexical (BM25 plus the model's synonyms); no embeddings. A question sharing no word with the document and
  none with the synonyms finds nothing and is offered to the office.
* Similarity thresholds for duplicate tickets (40% shared words, same topic, child, subject, person, 14 days) are heuristics.
* The keyword fallback (no model) treats a complaint as a question when it cannot see a safety or complaint word.
* The writer's Hinglish is sometimes awkward; Devanagari has few test questions.
* The model sometimes disagrees with itself between runs (section 5).
* A Hindi-teacher complaint in the demo school has no Hindi teacher in the timetable, so it falls back to the class teacher or the office.
* Evaluation sets were written by the developers; the numbers do not predict real parents' phrasing.
* Not done: deployment, CSP header, token still in localStorage, firebase advisories (backend 8 moderate, frontend 4 high),
  real-data Gaya copy has no documents, no production traffic, resolution percentage on real use unknown.
