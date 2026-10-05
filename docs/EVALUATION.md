# Evaluation: what was measured, how, and what it shows

Everything below was produced by commands in this repository on 5 Oct 2026 with Azure OpenAI gpt-4.1-mini; the saved
reports are `src/assistant/eval/last-model-report.json` and `last-answers-report.json` and are what the admin dashboard
shows. No figure is typed in by hand.

## 1. Routing accuracy: `npm run assistant:eval -- --model --save`

290 labelled questions (`eval/questions.json`): clear, ambiguous (one or two words), multi-topic, unsupported, safety and
complaint, in English, Hindi, Hinglish and with misspellings, across all roles. Each has the expected topic(s) and the expected
action (answer, clarify or hand-off). A question counts as right only if both match.

| Set | Questions | Topic | Action | Both |
|---|---|---|---|---|
| Development (keyword lists were tuned on it) | 165 | 96.4% | 98.8% | 96.4% |
| Holdout (never used for tuning) | 40 | 97.5% | 92.5% | 92.5% |
| Unseen (written later in new styles) | 45 | 93.3% | 97.8% | 93.3% |
| Fresh (written last, never tuned on) | 40 | 97.5% | 100% | 97.5% |
| **All** | **290** | **96.2%** | **97.9%** | **95.5%** |

Per-topic precision, recall and F1 and every mistake are printed by the command and shown on the dashboard. The 13 mistakes
are mostly single words ("late", "subject", "test") where asking is the right answer but the model answered, and genuinely
two-way questions ("exam ka syllabus kahan milega": exams or notes; "fees kab tak jama karni hai": a record or a rule).

Why the model reads the message first: with keywords alone the development set scores 100% (it was tuned on), but questions
written afterwards score 72 to 76% (measured earlier: 72.4% on 30 fresh questions); the model-first design scores 97.5% on fresh.

## 2. Is the confidence meaningful? (same run)

| Reported confidence | Questions | Actually right |
|---|---|---|
| 0.45 to 0.75 | 18 | 66.7% (mean reported 0.65) |
| 0.75 to 0.90 | 1 | 0% |
| 0.90 to 1.00 | 246 | 97.6% (mean reported 0.99) |

Calibration error 0.018 (0 is perfect). Reading: the number is honest where it matters. Below 0.75 the assistant is right about
two times in three, and it asks instead of answering; at 0.9 and above it is right 97.6% of the time. Of the 253 questions
answered without asking, 96% were right. Weak point: the middle band is almost empty, so the 0.75 threshold cannot be tuned
finer from this data; and the model reports 0.9 or more for nearly everything it is sure about.

Agreement between the model and the keyword reading is a strong signal: when they agree 98.7% are right (227 questions), when
they disagree 73.5% (34). A rule that asks whenever they disagree strongly was simulated on the same questions: it changed 1
question and no result, so it was not adopted (the disagreements are mostly weak keyword hints).

## 3. Did people get the right answer? `npm run assistant:answers -- --save`

The routing numbers say the topic was found. This measures the answer, against a running demo school (GVPS, with a parent of
two children, a student, a teacher and an admin). Each case says which facts must appear, which must not (the other child's
data, another student's), the expected action, and for hand-offs who the ticket went to; multi-turn chats check follow-ups,
topic switches and a clarifying question answered by the next message.

| Run | Result |
|---|---|
| First run of the 66-question set | 59 / 66 (89%) |
| 30 questions written after those fixes, run once | 27 / 30 (90%) |
| Whole set after fixing everything found (105 questions + 6 chats) | 111 / 111 |
| **20 questions written after all fixes, run once** | **19 / 20 (95%)** |

Read the 111 / 111 with care: that set was repaired until it passed, so it proves the fixes hold (and guards against
regressions), not accuracy on new questions. The 20-question final batch is the honest figure: 95%. Its one miss ("what time
does school start in the morning") found no section because the handbook says "timings" and "gate opens", not "time" and
"start"; the assistant correctly said it did not find a written answer rather than guess (document retrieval is lexical).

Failures found along the way and fixed (each now has a test): a marks question read as "scared" and sent as an urgent ticket;
the assistant answering for the asker's own record when asked about someone else; a refusal that wrongly blocked an exam-date
question; a model answering a Hinglish question in Devanagari with transliterated names; a one-word question missed because
the model's restatement added a general word; the title of a document outweighing the section that answered; the word
"refundable" not meeting "refund".

## 4. True end-to-end resolution (live, from the query log)

A correct route is not a resolution. Each question that reached an outcome is one unit:

* **resolved by the assistant**: answered, backed by a real record or document, not marked unhelpful, and not asked again in
  similar words within 10 minutes (a different question on the same topic, such as the other child's fees, is not a repeat);
* **resolved by staff**: handed off and the ticket was resolved;
* **unresolved**: no answer found and the offer to ask the office was not taken; answered without a source; marked unhelpful;
  repeated; a clarifying question never answered;
* **pending**: a ticket still open (counted neither way); **refusals** for access are correct behaviour and left out.

Also shown: clarify rate, hand-off rate, source coverage, the share of model-written answers that failed the number and name
check (2.5% on the evaluation traffic), speed (p50 2.9 s, p95 3.6 s), model use, tickets and average time to resolve.
`tests/assistant-metrics.test.js` checks the arithmetic on controlled rows. There is no production traffic yet: the demo log
contains only the evaluation's own one-shot questions with no feedback, so its resolution percentage says nothing about real
use and is not quoted here. It becomes meaningful with real users.

## Remaining limitations
* Document retrieval is word-based; a question using none of the document's words (and none of the model's synonyms) finds
  nothing and is offered to the office.
* The evaluation sets are written by the developers; real parents will phrase things differently. The dashboard's "needs
  attention" list and the thumbs feedback are the way to grow the sets.
* Hindi in Devanagari has few test questions compared with Hinglish and English.
* Latency is 2 to 4 s per message because the model runs twice (understanding, then writing); it is not streamed from the server.
