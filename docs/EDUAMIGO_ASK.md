# EduAmigo Ask

One assistant for everything in a school (Microsoft Innovate 2026, Problem Statement 18, "One Front Door
for Everything"). Students, parents, teachers, accountants and admins ask in English, Hindi or Hinglish,
and the assistant does one of three things:

- answers from the school's records and shows where the answer came from,
- asks a short question when it is not sure (which topic, which child, which class),
- hands the question to the right person as a ticket.

## How PS18 is met

| PS18 asks for | Where |
|---|---|
| One assistant, one front door | Ask button on every signed-in screen (`AskWidget.jsx`), `POST /api/assistant/ask` |
| Understand the topic and route it | `src/assistant/router.js`: weighted phrase matching first, a language model only when unsure |
| Several topics in one chat | `splitQuestions` (one message, several questions) and conversation memory (follow-ups) |
| Clarify when unsure | Confidence gate in `engine.js`: answer at 0.75 or more, clarify from 0.45, topic menu below that |
| Confidence with a clarify or hand-off fallback | Every reply carries `confidence` and `method`; tickets in `handoff.js` |
| Grounded, source-citing skill per domain | `src/assistant/skills/*.js`: each reads only its own records and returns sources and a screen link |
| Measure routing accuracy and true resolution | `npm run assistant:eval` (200 labelled questions), `GET /api/assistant/metrics`, Admin > EduAmigo Ask |

## The flow of one message

1. **Guard.** The user must be signed in, their school must have the `ai_assistant` feature, and there is a
   per-user hourly limit. Model use counts against the plan's monthly AI allowance; keyword answers are free.
2. **Choice.** A tapped button (or typing an option's name) resumes the question that was waiting.
3. **Safety.** Complaints, safety concerns, payment disputes and requests for a person become a ticket at once.
   Safety tickets are urgent and always go to the admins too.
4. **Split.** "Fees kitni baki hai aur kal exam kab hai" becomes two questions.
5. **Route.** Each question gets a topic, a runner-up and a confidence score:
   `strength (top score / 2) x (0.5 + 0.5 x margin over the runner-up)`. Below 0.75 the model is asked
   (if configured); its score is discounted and gets a bonus when it agrees with the keywords.
6. **Gate.** Answer, clarify between the two likely topics, or show a topic menu with "Ask the school office".
   A third unclear attempt in a row becomes a ticket.
7. **Access.** The topic must be open to the role (`domains.js`) and part of the school's plan.
8. **Details.** Which child (parents), which student (staff naming one; teachers only see their classes),
   which class (admins asking for a timetable), which teacher (HR).
9. **Skill.** Reads the records and returns the answer, its sources and the app screen to open.
10. **Writer.** For Hindi or Hinglish, the model rewords the answer. The reworded text is used only if every
    number in it appears in the original and no rupee amount was dropped (`writer.js`).
11. **Log.** The question (phone numbers, emails and ID numbers removed), topic, confidence, action, sources,
    speed and model use are logged for the metrics and the school's audit.

## Topics

Fees, attendance, timetable, exams and results, homework and notes, transport, notices and calendar, leave
requests, library, admissions, HR and payroll, and general (greetings, help, general knowledge). The keyword
lists, roles, plan features and hand-off teams are in `src/assistant/domains.js`.

Notes on the data:

- Results come from published marks only (`ExamResult`), never drafts.
- The school does not record a leave allowance, so HR answers give leave taken and pending, not a balance.
- The library records copies, not borrowers, so "my books" questions go to the librarian.
- The assistant never applies for leave or makes payments; it links to the screen that does.

## Language models

The assistant works without any model. With one, it also rewords answers in Hindi or Hinglish, answers
general questions briefly, and routes questions the keywords cannot place.

- `ASSISTANT_PROVIDERS=azure,gemini`: Azure OpenAI first, Gemini if Azure fails or times out
  (`ASSISTANT_TIMEOUT_MS`, default 6 s). A provider that fails three times in a row is skipped for a
  minute. Identical requests are cached for 10 minutes.
- `ASSISTANT_AI=off` turns model use off.
- `ASSISTANT_REWRITE=auto|always|never` controls rewording (auto: Hindi and Hinglish only).

### Setting up Azure OpenAI (Azure for Students)

Current setup: resource `eduamigo-ask` in resource group `eduamigo-ai`, region UAE North, deployment
`gpt-4.1-mini` (Global Standard, 50K tokens per minute), USD 10 monthly budget alert. Azure for Students
only allows a few regions (here Malaysia West, Central India, India South Central, UAE North, Korea Central);
Central India offers gpt-4.1-mini only as provisioned throughput, so UAE North is used. With the Azure CLI:

```
az cognitiveservices account create -n eduamigo-ask -g eduamigo-ai -l uaenorth --kind OpenAI --sku S0 --custom-domain eduamigo-ask
az cognitiveservices account deployment create -n eduamigo-ask -g eduamigo-ai --deployment-name gpt-4.1-mini \
  --model-name gpt-4.1-mini --model-version 2025-04-14 --model-format OpenAI --sku-name GlobalStandard --sku-capacity 50
```

From the portal:

1. Sign up at azure.microsoft.com/free/students with the university email (USD 100 credit, no card).
2. In the Azure portal create an **Azure OpenAI** resource (or an Azure AI Foundry project), region close
   to India if offered.
3. In Azure AI Foundry, **Deployments > Deploy model > gpt-4.1-mini**, deployment type **Global Standard**.
   Name the deployment `gpt-4.1-mini`.
4. Copy the endpoint (`https://<name>.openai.azure.com`) and a key into `.env`:
   `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_DEPLOYMENT=gpt-4.1-mini`.
   Never paste keys into chat or commit them.
5. Set a budget alert (Cost Management > Budgets, for example USD 10).
6. Check: `npm run assistant:eval -- --model` should report `keywords + model`, and Admin > EduAmigo Ask
   shows the provider.

A free Gemini key is a fallback only: its rate limit is reached after a few questions a minute.

## Measuring it

- `npm run assistant:eval`: routing accuracy, action accuracy, per-topic precision, recall and F1, a
  confusion matrix and every mistake, for the development set (may be used to improve keyword lists) and the
  holdout set (never used for tuning). `-- --model` includes the questions that need a model; `-- --json`
  prints the full report. Results on 4 Oct 2026: keywords only (191 questions) 100% topic accuracy, 98.4%
  fully correct, 92.1% on the holdout set; keywords + Azure gpt-4.1-mini (all 200) 100% topic accuracy,
  97% fully correct, 97.5% on the holdout set.
- The model is only consulted when the keywords are unsure. A tie between two topics the asker can use is
  always asked, never guessed; a single weak keyword is answered only when the model independently agrees.
- `GET /api/assistant/metrics?days=30` (admins): answered, clarify and hand-off rates, end-to-end resolution
  (answered, not handed off, not marked unhelpful, and not asked again about the same topic within
  10 minutes), source citation, speed (p50, p95), model use and tokens, tickets, and the questions that most
  often needed help.
- Admin > EduAmigo Ask shows both, plus every ticket.

## API

| Method | Path | Who | |
|---|---|---|---|
| GET | `/api/assistant/intro` | school users | topics and starter questions |
| POST | `/api/assistant/ask` | school users | `{ message, conversationId?, choice?: { type, value } }` |
| POST | `/api/assistant/feedback` | the asker | `{ queryId, helpful }` |
| GET | `/api/assistant/tickets?scope=mine\|assigned\|all&status=` | school users (`all`: admins) | tickets |
| PATCH | `/api/assistant/tickets/:id` | assignees and admins | `{ status?, note? }`; the sender is notified |
| GET | `/api/assistant/metrics?days=` | `assistant.insights` | live metrics |
| GET | `/api/assistant/evaluation` | `assistant.insights` | evaluation report (keywords only, no cost) |

`ask` returns `{ conversationId, queryId, language, replies: [...] }`. Each reply has `domain`, `label`,
`confidence`, `method` (keywords, model, context, choice, rule), `action` (answer, clarify, handoff, blocked,
no_data), `text`, `sources`, `link`, `actions`, `options` and `ticket`.

## Plans

The `ai_assistant` feature is part of the default Premium plan and can be sold as an add-on. A Premium plan
that the owner already saved from the console keeps its saved feature list, so add `ai_assistant` to it
there.

## Demo

`npm run demo` (or with `--from-backup`) fills every demo school with a month of activity so every topic has
something to answer. Try, as the Allied Chakand parent `9472012345` / `Demo@1234` (two children):

1. "Khushi ki fees kitni baki hai aur kal uska exam kab hai?" (two topics, two cited answers)
2. "New chat", then "attendance?" (asks which child)
3. "aur Khushi ki?" (follow-up keeps the topic)
4. "Bus mein kisi ne bachche ko maara" (urgent ticket; see it under Requests and in the admin portal)

As the admin `admin@aischakand.demo`: "attendance today, fee collection today and enquiries this week",
"which students in 1A have pending bus fees", "leave requests" (clarifies), "Ravi sir ki leave", then
Admin > EduAmigo Ask for the numbers.
