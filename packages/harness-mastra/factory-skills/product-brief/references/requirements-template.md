# requirements.md template (the brief)

Path: `<docs>/specify/<feature>/requirements.md`. Audience: **the client**, a non-technical person approving what gets built. Every line readable by a non-developer: no file, framework or widget names, no database or field names, no code, no API details, no design tokens or hex.

Write it in the person's language. Keep these headings, or the Ukrainian ones in brackets, so `factory_check_product_document` (`type: brief`) recognises them. **Required** (the check fails without them; write `None` with a reason rather than dropping one): Goal, Users, Use cases, Edge cases, Acceptance criteria, Not included, Constraints, Technology, Phases and estimate, Decisions that need the client's approval, Done means, Open questions. The rest (Behaviour, Guided flow, What the app remembers, Look and feel) is a menu: keep a section only if it carries weight. Delete the comments.

## Feature brief

````markdown
# <Feature>: brief

revision: <round> · status: draft | in approval | approved · source: <docs/raw/… files, the card>

## Goal  (Мета)
<!-- The problem in plain language: what is true today, why it is a problem, who feels it, and what "done" changes for them. 2–4 sentences. -->

## Users  (Користувачі)
<!-- Each role that touches this feature, what they do in it, what they need. Roles become the permission model later, so name every one. -->

## Use cases  (Сценарії)
<!-- One block per scenario, in the user's words. Keep the labels that fit. -->
### UC-1 — <name>
- **Who:** <role>
- **Wants:** <what, in their words>
- **Steps:** <what they do and see, screen by screen as they would name it>
- **Done when:** <something the user can observe, e.g. "the business name and address are filled in and saved">
- **On screen:** Headline "<exact text>" · Button "<exact label>" (<what happens when pressed>)

### UC-2 — …

## Behaviour  (Поведінка)
**When it appears:** <what makes it show up> · **Can it be skipped:** <yes/no, what stays behind> · **Coming back later:** <what the user sees next time>

## Guided flow  (Покроковий сценарій)
<!-- Only for walkthroughs (tips, a wizard). -->
| Step | Where | What it points at | What it says |
|---|---|---|---|
| 1 | <screen> | <element> | "<exact wording>" |

## What the app remembers  (Що застосунок пам'ятає)
<!-- Only if the user would notice it; one or two plain sentences, never a data structure. -->

## Edge cases  (Крайові випадки)
| Situation | What happens |
|---|---|
| <failure / empty / coming back later / already set up / no permission> | <exactly what the user sees> |

## Acceptance criteria  (Критерії приймання)
<!-- Numbered; each something the client can check themselves, without a developer. -->
1. <observable, checkable outcome>

## Not included  (Не входить)
- <thing> (<plain reason: needs more design first / a later phase / handled elsewhere>)

## Constraints  (Обмеження)
- <platforms, languages, accessibility, offline, data residency, "no paid third-party service without approval", nothing secret stored in the app>

## Technology  (Технології)
<!-- At the client's level: platforms, which existing systems it builds on, any new vendor or paid service and what it means for them (cost, lock-in). No architecture. -->

## Phases and estimate  (Фази та оцінка)
| Phase | What the client gets | Optimistic | Most likely | Pessimistic | Expected (PERT) | Commit to |
|---|---|---|---|---|---|---|
| 1 | … | … days | … days | … days | (O+4M+P)/6 | P75 / pessimistic |

**Team mode:** <people / people with agents (~share) / mostly agents>
**Estimate assumptions:**
- <each assumption the numbers rest on; what would move them>

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
4. **Main journeys** — first-time setup, the primary daily flow, any restricted or portal flow; screen by screen, in the user's words.
5. **Look and behaviour** — navigation, density, status labels, empty states, validation messages, which screen sizes matter.
6. **What the app keeps track of** — the minimum set of things it stores, what each holds in plain words, required vs optional. The seed of the data model.
7. **Acceptance criteria** — numbered, each checkable by the client.
8. **Not included in the first release** — with the reason.
9. **Constraints.**
10. **Technology** (client level), **phases and estimate**.
11. **Decisions that need the client's approval.**
12. **Done means.**
13. **Open questions.**

Quality bar: every acceptance criterion is checkable by the client without asking you; every feature names the things it keeps track of and each appears in section 6; non-goals and approval gates are explicit; open questions are listed, not guessed.
