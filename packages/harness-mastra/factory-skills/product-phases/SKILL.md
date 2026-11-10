---
name: product-phases
description: Split an agreed technical spec into independently verifiable phases with a person, then file each phase as a Development card per repository, linked to the exact spec sections it implements
---

# Product Phases

Split the agreed technical **spec** on this Product card into **phases** the Development board can build: each a finished, checkable piece (a contract, a domain change, a screen), some able to run in parallel and some only after others. Then file each phase as a card on the Development (Work) board, one per repository, under this Product card. Agree on the list **with a person in this session** before filing anything.

**No code is ever written on the Product board.** A phase says *what* is delivered and *how it is checked*, never how it is coded: it is not an implementation document, and it holds no code.

> **Skeleton.** Adjust the sizing rules and the card template to the team's practice through Settings › Skills.

## Inputs

- **The spec**, agreed (its check passed in Spec review). Continue from this session if it wrote it; otherwise find it in the documentation folder named by the phase instructions or by the card. If it is missing, **stop and ask** the person.
- **Repositories.** Every card names exactly one repository linked to this Factory, in `owner/name` form: the one the phase's code lives in. The spec's *Components* say which; if a component has no repository, **stop and ask**.

## Where the documents live

A project keeps **all** its documentation in **one folder** (a documentation repository, or one folder in a monorepo), never split per component. The Development agents that build each phase have that folder in their workspace when the documentation repository is part of the Factory's environment, so every card links to the exact sections it implements, by path and heading, e.g. `docs/features/loyalty/spec.md#contracts` and `docs/features/loyalty/spec.md#sequences`.

## Steps

1. **Propose the phases.** List them with, for each one:
   - title;
   - repository;
   - what it delivers, in one or two lines;
   - the spec sections it implements (path#heading: contracts, sequences, components, test-plan scenarios);
   - acceptance criteria and test-plan scenarios it must pass, copied from the spec;
   - dependencies: which phases must land first; which can run in parallel.

   Order them so that contracts land before the code that uses them. Prefer vertical slices that can be checked on their own over layers that cannot. A change that spans two repositories is two phases, one per repository, with the dependency between them.
2. **Size them.** A phase that cannot be reviewed as one change request is too big; split it. One that only makes sense together with another may be merged with it. Flag every phase whose acceptance criteria you could not take from the spec: the spec has a gap there; ask the person rather than invent criteria.
3. **Agree.** Show the list in the session and wait for the person to accept, change or drop phases. Do not file anything before they say so.
4. **File them.** For each accepted phase, call `factory_create_work_item` with:
   - `title`;
   - `repository` (`owner/name`);
   - `brief`: what it delivers, its acceptance criteria and test-plan scenarios, its dependencies, and the links to the spec sections and to this Product card.

   The card lands in Development › Intake, its parent is this Product card, and this card lists it. Filing the same title again returns the existing card, so a retry never duplicates. If a call fails, report it and continue with the others. Do not retry blindly.
5. **Record.** Add a *Phases* section to the spec listing each filed card with its dependencies, commit it (`docs(spec): <title>, phases`), and push with `source_control_push_branch`.
6. **Hand off.** Post the list of filed cards in the session, then move this card to `phases-review` with `factory_transition_work_item`. Moving it to Done needs at least one filed card.

## Revisions

When the card comes back from `phases-review`, fix what the person points out. File missing phases and comment on cards to change; never delete cards yourself. Then hand off again.

## Never

- Never write or change code, and never put code in a card.
- Never start runs on the filed cards. People start them on the Development board.
- Never merge the documents' change request.
- Never copy content from one private repository into another, or into a public one.
