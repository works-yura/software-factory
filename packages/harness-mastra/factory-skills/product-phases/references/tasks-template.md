# tasks.md template (the phases)

Path: `<docs>/changes/<change>/tasks.md`. Fixed shape, so completeness can be checked **without asking the author**. Write it in the person's language, but keep the section headings (`## Order`, `## Tasks`, `## Coverage check`, or `## Порядок`, `## Задачі`, `## Покриття`) and the **field names** below in English: `factory_check_product_document` (`type: tasks`) reads every `### <ID> — <title>` under `## Tasks` and requires `role`, `depends-on`, `acceptance` and `verify` on each, and every `depends-on` id to be a task in this file (a cross-feature dependency is written `<change>/<ID>`).

Ids: a short feature prefix and a number (`SB-01`, `SB-02`). Permanent: never renumber; a split becomes `SB-04a` / `SB-04b`.

````markdown
# <Feature>: tasks

revision: 1 · status: draft | approved | in-progress | shipped · design: design.md (revision <n>)

## Order
<The dependency graph in reading order. Foundation first; parallel tasks on one line.>
1. SB-01 → 2. SB-02, SB-03 (parallel) → 3. SB-04 → 4. SB-05 → 5. SB-06

## Tasks

### SB-01 — Subscription schema and access rule
- role: backend
- repository: acme/api
- depends-on: none
- touches: subscriptions collection, access middleware
- acceptance: AC-2 (access is granted only while a subscription is active) — restated in one line each
- design: design.md#data-model, design.md#security
- verify: integration: an expired subscription is refused with 403 subscription_inactive
- gate: human — irreversible migration of existing accounts (omit when not needed)
- notes: <only what the engineer must know that is not in design.md>

### SB-02 — Create-subscription endpoint
- role: backend
- repository: acme/api
- depends-on: SB-01
- touches: POST /subscriptions
- acceptance: payments/Scenario: subscribe with a valid card; payments/Scenario: declined card
- design: design.md#api-contract, design.md#sequences
- verify: contract test against CreateSubscriptionDto / SubscriptionDto; e2e: declined card → 402 payment_failed

### SB-03 — Paywall screen
- role: mobile
- repository: acme/mobile
- depends-on: SB-02, auth/AU-02
- touches: features/subscriptions
- acceptance: payments/Scenario: paywall shows plans; payments/Scenario: declined card
- design: design.md#api-contract, design.md#ui
- verify: widget test per state (empty, loading, error, declined); golden for the paywall

### SB-DOCS — Merge the change into features/
- role: docs
- repository: acme/docs
- depends-on: SB-01, SB-02, SB-03
- touches: features/subscriptions/design.md, changes/archive/
- acceptance: the truth describes what was built: every ADDED and MODIFIED requirement merged (or its deviation), every REMOVED one gone; the change archived
- design: design.md#affected-areas
- verify: the docs-sync plan lists every requirement of the delta and the deviations from the tasks' change requests

## Coverage check
| AC | Task(s) |
|---|---|
| AC-1 | SB-02, SB-03 |
| AC-2 | SB-01 |
Every acceptance criterion has at least one task. Every task has at least one criterion, or is a foundation / docs task and says so.

The **last task is always the docs-sync task** (`<prefix>-DOCS`, `role: docs`, in the documentation repository), depending on every other task: Development merges the change's delta into `features/<area>/design.md` on it, from what was actually built, and archives the change. It is filed with `docsSync: true`.

## Superseded
<On amend: retired tasks with `superseded-by: <id>`. Never delete a task that has shipped.>
````

Sizing rule of thumb: one engineer, one sitting, one reviewable change request. If a title needs "and", split it. If `touches` spans two repositories, split it along the API contract and cite the contract from both halves.
