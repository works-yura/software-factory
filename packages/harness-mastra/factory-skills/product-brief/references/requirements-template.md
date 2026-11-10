# requirements.md template (the brief)

Path: `<docs>/changes/<change>/requirements.md`. Audience: **the client**, a non-technical person approving what gets built. Every line readable by a non-developer: no file, framework or widget names, no database or field names, no code, no API details, no design tokens or hex.

**Two language versions.** `requirements.md` is in the team's language (Ukrainian for this team); when the client works in another language (find it from how the client writes in `blackbox/sources/`; Alex writes English), also keep `requirements.<lang>.md` (e.g. `requirements.en.md`) — the same brief, translated, section for section, with the English headings. The client gets the client-language file; both are updated in the same round and must say the same thing. Each passes the check.

Write it in the person's language: for this team, **the Ukrainian headings in brackets and Ukrainian labels** (Хто / Хоче / Кроки / Готово, коли / На екрані); the English names are only what the check also accepts. **Required** (the check fails without them; write `None` with a reason rather than dropping one): Goal, Users, Use cases, Edge cases, Out of scope, Constraints, Technology, Running costs, External dependencies and risks, Phases and estimate, Decisions that need the client's approval, Done means, Open questions.

**Nothing internal in the client's text:** no file paths, no `blackbox/…` sources, no `DEC-nnn` / `OQ-nnn` ids, no estimation formulas or team mode. Sources and working figures go in the change request description (or `research.md`). The rest (Behaviour, Guided flow, What the app remembers, Look and feel) is a menu: keep a section only if it carries weight. Delete the comments.

## Feature brief

````markdown
# <Feature>: brief

редакція: <round> · статус: чернетка | на погодженні | погоджено · запит від: <date of the client's request, in words>

## Goal  (Мета)
<!-- The problem in plain language: what is true today, why it is a problem, who feels it, and what "done" changes for them. 2–4 sentences. -->

## Users  (Користувачі)
<!-- Each role that touches this feature, what they do in it, what they need. Roles become the permission model later, so name every one. -->

## Use cases  (Сценарії)
<!-- One block per scenario, in the user's words. Keep the labels that fit. -->
### UC-1 — <name>
- **Хто:** <role>
- **Хоче:** <what, in their words>
- **Кроки:** <what they do and see, screen by screen as they would name it>
- **Готово, коли:** <something the user can observe, e.g. "назва й адреса бізнесу заповнені й збережені">
- **На екрані:** Заголовок "<exact text>" · Кнопка "<exact label>" (<what happens when pressed>)

### UC-2 — …

## Behaviour  (Поведінка)
**Коли з'являється:** <what makes it show up> · **Чи можна пропустити:** <yes/no, what stays behind> · **Повернення пізніше:** <what the user sees next time>

## Guided flow  (Покроковий сценарій)
<!-- Only for walkthroughs (tips, a wizard). -->
| Step | Where | What it points at | What it says |
|---|---|---|---|
| 1 | <screen> | <element> | "<exact wording>" |

## What the app remembers  (Що застосунок пам'ятає)
<!-- Only if the user would notice it; one or two plain sentences, never a data structure. -->

## Edge cases  (Особливі випадки)
<!-- Required, as a TABLE (the check refuses a list). One row per situation the client can run into; the right column says what the user SEES, with the exact on-screen or message text in quotes when there is one. Only situations a client can observe: internal guarantees (no duplicates on retry, idempotency, queues) belong to the spec. A case whose behaviour is a choice (e.g. what happens to an email address that bounces) is decided with the person through the question tool first, then written here as the agreed behaviour. -->
| Situation (Ситуація) | What the user sees (Що бачить користувач) |
|---|---|
| <the booking's professional is changed from Ana to María> | <both get "Cita reprogramada" with the line "Profesional: Ana → María"> |
| <the business is frozen for non-payment> | <no push or email; the bell keeps collecting, so after payment the history is there> |

## Out of scope  (Межі оцінки)
- <thing> (<plain reason: needs more design first / a later phase / handled elsewhere>)

## Constraints  (Обмеження)
- <limits on the product itself: platforms, languages, accessibility, offline, data residency, "no paid third-party service without approval", nothing secret stored in the app. Not how we work — that goes to How we deliver.>

## How we deliver  (Процес роботи)
<!-- How the work is shown and accepted, not a limit on the product: e.g. "every change goes to staging first, you check it there, and only then to prod"; how often you see progress; who accepts. Omit if nothing beyond the usual. -->

## Technology  (Технології)
<!-- At the client's level: platforms, which existing systems it builds on, any new vendor or paid service and what it means for them (cost, lock-in). No architecture. -->

## Running costs  (Витрати на експлуатацію)
<!-- Required. What the client will pay third parties every month once this ships — not our development price. One row per paid service. Every figure comes from the provider's own pricing page, fetched in this session, quoted with its link and the date checked; a figure you could not verify is marked "не перевірено" and is a question, never a number in the brief. "None: no paid third-party service" when that is so. -->
| Service | What it is for | Plan and what it includes | Next tier, and what triggers it | Expected volume (assumption) | Cost per month | Who pays | Source (checked on) |
|---|---|---|---|---|---|---|---|
| <Resend> | <notification emails> | <Free: 3 000/month, 100/day> | <Pro $20/month from 50 000/month> | <~30 emails/day per business × N businesses> | <$0 → $20 at ~N businesses> | <the client (Syncta) / each of his customers> | <https://resend.com/pricing, 2026-11-10> |

**If the client's product is a service for his own customers** (a platform used by many businesses): give the cost **per customer per month** at the expected usage, say whether it is included in his plan to them or passed on, and the point where a tier change makes it jump.

## External dependencies and risks  (Зовнішні залежності й ризики)
<!-- Required. Everything outside the team that the work waits on or can be blocked by, found with the checklist in SKILL.md. Work hours and calendar time are different things: 10 hours of work can wait three weeks for a review. "None found" only after the checklist was run, saying so. -->
| # | What | Who must act | Wait (calendar) | Blocks | Mitigation |
|---|---|---|---|---|---|
| D-1 | <e.g. Meta approves the WhatsApp message templates> | <Meta; we submit, client's business account> | <1–2 days, rejections restart it> | <go-live of #N> | <submit in week 1; text fallback> |
| D-2 | <e.g. DNS records on syncta.app for email (SPF/DKIM)> | <whoever administers the domain: client> | <same day once access is given> | <email channel> | <ask for access now> |

## Phases and estimate  (Фази та оцінка)
| Фаза | Що отримує клієнт | Робота | Календарно, з очікуваннями |
|---|---|---|---|
| 1 | … | <one committed range, e.g. "30–46 год"> | <e.g. "~1,5–2 тижні; email — не раніше ніж через 1–2 дні після доступу до DNS"> |

<!-- Only the table. No paragraphs under it: no "Календар: … weeks of one developer at N hours a week", no team size or capacity, no "На чому тримається оцінка" list. The calendar column says it in one short cell. An assumption that is really scope ("no store apps", "one language") goes to Межі оцінки; everything else (working figures — optimistic / most likely / pessimistic, PERT, P75, team mode, capacity, assumptions) goes in research.md or the change request description, never in the brief. -->

## Decisions that need the client's approval  (Рішення, що потребують погодження клієнта)
<!-- The gates the team must not pass alone: switching on a paid service, sending real emails or payments, publishing to the stores, touching real customer data, deleting or migrating data, declaring the release final. "None" if none. -->

## Done means  (Готово означає)
- [ ] <the closing checklist: works from a clean install, demo data present, every use case walked through, every acceptance criterion ticked, hand-over notes delivered>

## Look and feel  (Вигляд)
<!-- Optional, plain words only: "matches the app's usual look". -->

## Open questions  (Відкриті питання)
- <question> — who can answer it — what it blocks   (or "None")
````

## Whole product or MVP

When the brief is for a whole product or an MVP ("an app that…"), not one feature, keep the same voice and cover all of these, in order:

1. **Product goal** — what is built, for whom, what "usable" means for the first release.
2. **Who uses it** — every role, what they do, what they need.
3. **Features by area** — grouped; each with its states (empty, loading, error, done) and the things it keeps track of. One paragraph each; each gets its own feature brief later.
3a. **Edge cases** — across features: failure, empty, second time, paused or unpaid account, one person in several businesses.
4. **Main journeys** — first-time setup, the primary daily flow, any restricted or portal flow; screen by screen, in the user's words.
5. **Look and behaviour** — navigation, density, status labels, empty states, validation messages, which screen sizes matter.
6. **What the app keeps track of** — the minimum set of things it stores, what each holds in plain words, required vs optional. The seed of the data model.
8. **Out of scope (Межі оцінки)** — what this estimate does not cover, with the reason.
9. **Constraints.**
10. **Technology** (client level), **running costs**, **external dependencies and risks**, **phases and estimate**.
11. **Decisions that need the client's approval.**
12. **Done means.**
13. **Open questions.**

The check needs the same required headings as a feature brief (see the top of this file): name the sections so (e.g. "Edge cases (Крайові випадки)").

Quality bar: every use case says when it is done in terms the client can see; every feature names the things it keeps track of and each appears in section 6; non-goals and approval gates are explicit; open questions are listed, not guessed.

<!-- No acceptance-criteria section in the brief: the client sees "Готово, коли" in each use case and "Done means"; testable acceptance criteria (GIVEN/WHEN/THEN) belong to the spec. -->
