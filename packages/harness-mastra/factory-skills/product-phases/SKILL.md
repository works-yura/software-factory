---
name: product-phases
description: Cut the agreed design into an INVEST-atomic, dependency-ordered backlog (tasks.md) that passes a Definition of Ready, agree it with a person, then file exactly one Development card per task, per repository, linked back to its task and design sections and to this Product card
---

# Product Phases

Turn the agreed **design** (`design.md`) on this Product card into the backlog the Development board builds: `<docs>/changes/<change>/tasks.md`, every task **INVEST**-atomic, ordered by its dependency graph, foundation first, each carrying its slice of the acceptance criteria and how it is proven. Agree the list **with a person in this session**, then file **one Development (Work) card per task**, under this Product card. The failure this prevents: an engineer re-deciding the architecture per task, two tasks editing the same schema, and "done" being a matter of opinion.

**No code is ever written on the Product board.** A task says *what* is delivered and *how it is checked*, never how it is coded. tasks.md is not an implementation document and holds no code.

**Asking the person.** When you need the person's decisions (a batch of gaps, a choice between options), ask with the question tool when the session offers one (`AskUserQuestion` / `ask_user`), as `product-enrich` describes: up to 4 self-contained questions per call, 2–4 options each, your recommended answer first with ` (рекомендовано)` at the end of its label, then wait. Write the questions as text only when no question tool is offered.

Ask only what passes `product-enrich`'s test (the person's call, changes what is built or the estimate, not settled by facts); do bookkeeping silently, and put every interpretation or scope point as a question with options, never in a "decided myself" note (`skill_read` skill `product-enrich`, section "What deserves a question").

## Where the documents live

A project keeps **all** its documentation in **one folder** `<docs>` (a documentation repository, or one folder in a monorepo), **never split per component**. Use the folder this card already used; otherwise the phase instructions' folder; otherwise **stop and ask**. The layout and what you may write are in `references/docs-layout.md` of the `product-enrich` skill (`skill_read` with skill `product-enrich`).

This phase reads `<docs>/changes/<change>/requirements.md` (use cases and acceptance criteria) and `design.md` (contract, data, shared resources, test plan, the answers to `<docs>/rules/`), and writes `<docs>/changes/<change>/tasks.md` and the feature's row in `<docs>/features/INDEX.md`. It never edits another feature's documents, `rules/`, `bugs/` or `audits/`.

`<docs>/changes/<change>/` is the **source of truth for this change's plan** (`features/<area>/design.md` stays the truth of how the system works). Development cards are projections of `tasks.md`, one card per task, each linking back to `tasks.md#<task-id>`. When the plan changes, it changes here first.

The Development agents that build each task have the documentation in their workspace when the documentation repository is part of the Factory's environment ("in environment" in Settings › Repositories). If it is not, say so to the person: the cards' links will not resolve for them.

## Inputs

- **The design**, agreed: its check passed in Spec review. If it is missing, **stop and ask**.
- **The brief**: every acceptance criterion must end up owned by a task.
- **Repositories.** Every card names exactly one repository linked to this Factory, as `owner/name`. *Modules touched* in the design says which; if a component has no repository, **stop and ask**.

## Steps

1. **Draft `tasks.md`** from `references/tasks-template.md` (`skill_read` with skill `product-phases`), in the person's language, keeping the template's headings and field names so the check recognises them:
   - **Foundation first.** Each shared resource named in the design (schema, auth, design tokens, shared widgets) is **one** foundation task; every task that touches it `depends-on` it and never edits it.
   - **Default chain** per feature: foundation → backend → (design →) mobile / web → qa (the test plan's scenarios) → docs. Drop a link only when the feature truly has no such side.
   - **INVEST:** Independent, Negotiable, Valuable, Estimable, Small (one engineer, one sitting, one reviewable change), Testable. A task whose title needs "and" is two tasks. A task whose `touches` spans two repositories (backend and mobile) is split along the API contract, both halves citing it.
   - **Every task carries** `role`, `repository`, `depends-on`, `touches`, `acceptance` (its slice of the brief's criteria, each restated in one line), `design` (the design sections it implements, as `design.md#<heading>`), `verify` (how it is proven: unit / widget / golden / integration / e2e, or the exact manual step and expected result), and `gate: human` when it needs approval (destructive migration, paid service, public deploy, real customer data).
   - **Never invent** a task the brief and design do not need, and never leave an acceptance criterion without a task. When the design has a gap, ask the person; don't improvise around it.
   - Fill the **coverage check**: every criterion → its task(s).
2. **Definition of Ready.** Every task must pass all of these; one missing means it is not ready — fix it or ask:
   - maps to a use case / user story with clear value;
   - its acceptance is checkable without asking the author;
   - INVEST-atomic;
   - `depends-on` identified, foundation sequenced before it, no cycles;
   - `verify` says how it is proven;
   - the design's consult round and pre-mortem covered what it touches.
3. **Check** with `factory_check_product_document` (`type: tasks`, the path, and any contradictions with the design or the brief). It verifies the sections and that every task has `role`, `depends-on`, `acceptance` and `verify`, and depends only on tasks that exist. Fix what it reports and run it again. Handing the card to Phases review needs a passing check.
4. **Agree.** Show the order and the task list in the session, with the open questions and the tasks marked `gate: human`, and **wait** for the person to accept, change or drop tasks. File nothing before they say so.
5. **File the cards.** For each accepted task, in dependency order, call `factory_create_work_item` with:
   - `title`: `<ID> — <title>`;
   - `repository`: the task's `owner/name`;
   - `brief`: what it delivers; its acceptance criteria; `verify`; its dependencies (by id, with the card titles already filed); the links `<docs>/changes/<change>/tasks.md#<id>` and each `design.md#<heading>` it implements; and, at the end, the human gate below, verbatim.

   The card lands in Development › Intake, its parent is this Product card, and this card lists it. Filing the same title again returns the existing card, so a retry never duplicates. If a call fails, report it and continue with the others; do not retry blindly.

   > **HUMAN-GATE:** if the implementation needs an architectural change, touches modules outside this card's scope, or needs a destructive or irreversible action, stop and hand back to a person with a concrete proposal. Do not expand the scope or loop. The plan lives in `docs/features/`: change it there first.

   **Last, the docs-sync task** (`<prefix>-DOCS`, depending on every other task): file it with `docsSync: true` and the documentation repository as `repository`, and a brief that lists every filed card in order (title, task id, repository, card link). Development merges the change's delta into `features/<area>/design.md` on it, from what the other cards actually built, and archives the change; a person starts it once the others are merged. The tool records this change's folder on every card from your passing tasks check, so run that check before filing.
6. **Record.** In `tasks.md` set `status: approved` and add each filed card under its task (`- card: <link>`); update the change's row in `<docs>/features/INDEX.md` (status `phased`, foundation resources). Run the check again, commit (`docs(tasks): <feature>`), and push with `source_control_push_branch`; the card's change request picks it up.
7. **Hand off.** Post the filed cards in order in the session, then move this card to `phases-review` with `factory_transition_work_item`. Done needs at least one filed card.

## Amend: the plan changed

When the brief or design changes after the cards exist, update only the affected tasks: bump `revision`, add new tasks with the next free id, and retire changed ones as `superseded-by: <id>` (never delete a task that has shipped, and never renumber). File cards for new tasks; comment on existing cards to change them. Never delete cards yourself.

## Revisions

When the card comes back from Phases review, fix what the person points out the same way, check again, and hand off again.

## Never

- Never write or change code, and never put code in a card.
- Never start runs on the filed cards: people start them on the Development board.
- Never invent tasks that tasks.md does not hold, or file a card for a task that is not in it.
- Never merge the documents' change request.
- Never copy content from one private repository into another, or into a public one.

---

Built from eclipt's `spec-driven-planning` (tasks.md, Definition of Ready, amend) and `decomposition` (one card per task, foundation first, never invent tasks, the HUMAN-GATE) skills.
