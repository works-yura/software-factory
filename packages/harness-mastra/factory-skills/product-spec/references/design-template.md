# design.md template (the technical spec, as a delta)

Path: `<docs>/changes/<change>/design.md`. Audience: the team. A **delta** against the truth: for each area the change touches, what is ADDED, MODIFIED or REMOVED relative to `features/<area>/design.md`, plus how the change fits the system. It never copies the area's whole truth, and never edits `features/`: when the change ships, its delta is merged into `features/<area>/design.md` and the change is archived. An area with no truth yet gets a baseline first (`area-baseline.md`). Fixed shape, so a reviewer can check completeness **without asking the author**: adapt wording, not structure. Fill every section: `None` when it does not apply, `Open question: <what>` when the source does not say.

Write it in the person's language. Keep these headings or the Ukrainian ones in brackets: `factory_check_product_document` (`type: spec`) requires Affected areas, at least one of ADDED / MODIFIED / REMOVED Requirements (ДОДАНО / ЗМІНЕНО / ВИЛУЧЕНО вимоги), Architecture, Sequences, Data flow, Modules touched, API contract, Data model, Security, Shared resources, Test plan, Decisions, Consult round, Premortem outcome and Open questions, plus a `C4Context` or `C4Container`, a `sequenceDiagram` and a `flowchart` Mermaid block for the flows the change adds or changes.

`````markdown
# <Change>: design (delta)

revision: 1 · status: draft · brief: requirements.md (revision <n>) · research: research.md
against: features/<area>/design.md @ <commit>, … · builds on: <AGENTS.md / CLAUDE.md>, <docs/README.md>, <DEC-nnn>, <adr/…>

## Affected areas  (Зачеплені області)
| Area | Truth | Baseline written by this change? |
|---|---|---|
| payments | features/payments/design.md | no |

<!-- One delta block per affected area. Requirements: `### Requirement: <name>` stating behaviour with SHALL / MUST,
each with `#### Scenario: <name>` GIVEN / WHEN / THEN. MODIFIED restates the WHOLE requirement as it will be, with
"(Previously: …)"; REMOVED gives the reason and what replaces it. Omit a heading the change does not need. -->

## ADDED Requirements — payments  (ДОДАНО вимоги — payments)
### Requirement: Subscription checkout
The system SHALL let a signed-in customer subscribe to a plan with a card.
#### Scenario: Card declined
- GIVEN a signed-in customer without a subscription
- WHEN they subscribe and the provider declines the card
- THEN they see "Payment failed" and no access is granted

## MODIFIED Requirements — payments  (ЗМІНЕНО вимоги — payments)
### Requirement: <existing requirement name, exactly as in the area's truth>
<the whole requirement as it will be> (Previously: <what it said>)
#### Scenario: <name>
- GIVEN … WHEN … THEN …

## REMOVED Requirements — payments  (ВИЛУЧЕНО вимоги — payments)
### Requirement: <existing requirement name>
Reason: <why> · Replaced by: <requirement, or "nothing">

## Architecture  (Архітектура)
<!-- C4 context (people and systems) and/or container (apps, services, databases) level, as it will be after the change; names as the areas' truth uses them. New or changed elements marked. -->
```mermaid
C4Context
  Person(customer, "Customer")
  System(product, "Our product")
  System_Ext(stripe, "Payment provider")
  Rel(customer, product, "uses")
  Rel(product, stripe, "charges via")
```

```mermaid
C4Container
  Container(mobile, "Mobile app", "Flutter")
  Container(api, "API", "NestJS")
  ContainerDb(db, "Database", "Firestore")
  Rel(mobile, api, "HTTPS/JSON")
  Rel(api, db, "reads/writes")
```

## Sequences  (Послідовності)
<!-- One per main use case of the brief (UC-n), including the failure paths that matter. -->
```mermaid
sequenceDiagram
  participant M as Mobile
  participant A as API
  participant P as Payment provider
  M->>A: POST /subscriptions
  A->>P: create subscription
  P-->>A: 402 card declined
  A-->>M: 402 payment_failed
```

## Data flow  (Потік даних)
```mermaid
flowchart LR
  mobile[Mobile app] -->|subscription request| api[API]
  api -->|subscription record| db[(Database)]
  provider[Payment provider] -->|webhook: status| api
```

## Modules touched  (Модулі, що змінюються)
| Repository | Module / package | Layer | Change |
|---|---|---|---|
| acme/api | src/subscriptions | application | new module |
| acme/mobile | features/subscriptions | domain, data, presentation | new |

## API contract  (API-контракт)
| Method | Path | Auth | Request DTO | Response DTO | Errors |
|---|---|---|---|---|---|
| POST | /subscriptions | user | CreateSubscriptionDto | SubscriptionDto | 400 validation, 401, 402 payment_failed, 409 already_active |

### DTOs
<!-- Field lists with type, nullability, validation; one block per DTO. Shapes only, no code. -->

### Error contract
<!-- The shape of an error response; which codes each client must handle and how. -->

### Events
<!-- Webhooks, queues, domain events: name, producer, consumers, payload fields. "None" if none. -->

## Data model  (Модель даних)
| Entity | Collection / table | Fields (type, nullable) | Relationships | Indexes |
|---|---|---|---|---|

### Migration / backfill
<!-- Needed? What runs, in what order, reversible or not. Irreversible → the owning task is `gate: human`. -->

## Security  (Безпека)
- Identity: <how it is established on every request; which claims are used; where the role comes from — a trusted claim, never the body>
- Authorization: <per endpoint, who may call it>
- BOLA / IDOR: <for every user- or company-scoped path, the server-side filter that makes another owner's record unreachable>
- Client bundle: <nothing privileged shipped to the client>
- Input, rate limits, logging: <validation on every endpoint; limits on auth, expensive and enumeration-prone endpoints; no secrets or PII in logs>

## Shared resources  (Спільні ресурси)
<!-- Schema, auth, design tokens, shared widgets: each named once; each becomes ONE foundation task in tasks.md that every consumer depends on. -->
| Resource | Owning task | Consumers |
|---|---|---|

## Non-functional requirements  (Нефункціональні вимоги)
<!-- Only those that matter here: latency / cold-start budget, offline, observability (what is logged, what alerts), limits. -->

## UI  (Інтерфейс)
<!-- Omit for backend-only features. -->
- Design source: <design file / screen @ revision, or "a design task produces it">
- Tokens → widgets: <existing theme tokens only; new tokens go through the design system, never inline values>
- Responsive / adaptive: <what changes at each breakpoint>
- Navigation: <routes added; deep links>
- States: <empty / loading / error / offline / permission denied, per the brief's edge cases>

## Test plan  (План тестування)
**Seams:** <where the feature is tested from: the highest seams possible, existing ones preferred; confirmed with <person>>
**What a good test is here:** external behaviour only, not implementation details.
**Prior art:** <similar tests already in the codebase, with paths>

| Scenario | Kind (black-box / integration / contract / e2e) | Seam | Covers (UC / scenario) | Data |
|---|---|---|---|---|
| A declined card shows "Payment failed" and no access is granted | e2e | mobile → API | UC-1, payments/Scenario: declined card | test card 4000…0002 |

Every use case of the brief and every requirement scenario appears in *Covers* at least once. The acceptance criteria live here, as the GIVEN/WHEN/THEN scenarios of the requirements — the brief has none.

## Decisions  (Рішення)
### ADR-1 — <decision title>
- Context: <one line>
- Decision: <one line>
- Consequences: <one line, including what becomes hard>
- Record: <proposed DEC-nnn; plus adr/000N-… for a big technical decision that outlives the feature; or "local">

### Rules  (Правила)
<!-- Every rule in <docs>/rules/ this feature falls under, answered. A rule that asks questions before a feature (e.g. critical questions) gets each question answered here, pointing at the test scenario or section that covers it; "does not apply, because …" is an answer, silence is not. -->
| Rule | Item | Answer | Covered by |
|---|---|---|---|
| rules/<file>.md | <question / requirement> | <answer> | <test-plan scenario / section> |

## Consult round  (Консультаційний раунд)
| Lens | Verdict | Change made / open question |
|---|---|---|
| Backend: contract and data | Agree / Object | <specific change, e.g. "DTO missing ownerId; added, filtered server-side"> |
| Mobile | | |
| Web / landing | | |
| Security | | |
| Design | | <or "skipped — no UI"> |

## Premortem outcome  (Результат премортему)
**Verdict:** <sound as-is / sound after the must-handles / needs a rethink>
**Lenses run:** <which, and which skipped and why>
- Must handle now (folded in): <finding — the structural reason — the section it changed>
- Safe to defer: <title — one line>
- Explicitly out of scope: <title — one line>

## Open questions  (Відкриті питання)
- <question> — who answers it — blocks: <sections / tasks, or "none">
`````

_Delta format adapted from OpenSpec (Fission-AI/OpenSpec, MIT)._
