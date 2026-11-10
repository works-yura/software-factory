---
name: product-breakdown
description: Cut an agreed specification into work items per repository with a person, then file them on the Work board
---

# Product Breakdown

Cut the agreed **specification** on this Product card into **work items** that Factory's Work board can build: each small enough for one change request, in one repository, with clear acceptance criteria and a link back to the spec. Agree on the list **with a person in this session** before filing anything.

> **Skeleton.** Adjust the sizing rules and the work item template to the team's practice through Settings › Skills.

## Inputs

- **The spec.** Continue from this session if it wrote the spec. Otherwise find it from the card, or in the documents folder named by the phase instructions. If there is no agreed spec, stop and ask the person.
- **Repositories.** The phase instructions name the code repository of each component. Every work item names exactly one of them, in `owner/name` form, and it must be a repository linked to this Factory. If the mapping is missing, **stop and ask**.

## Steps

1. **Propose the cut.** List the work items with, for each one:
   - title;
   - repository;
   - the spec section it implements;
   - acceptance criteria copied from the spec;
   - dependencies on other items.

   Order them so that contracts land before the code that uses them. Prefer vertical slices that can be checked on their own over layers that cannot.
2. **Size them.** An item that cannot be reviewed as one change request is too big; split it. An item that only makes sense together with another may be merged with it. Flag every item whose acceptance criteria you could not take from the spec. The spec has a gap there: ask the person rather than invent criteria.
3. **Agree.** Show the list in the session and wait for the person to accept, change or drop items. Do not file anything before they say so.
4. **File them.** For each accepted item, call `factory_create_work_item` with:
   - `title`;
   - `repository` (`owner/name`);
   - `brief`: the item's description, its acceptance criteria, its dependencies, and links to the spec section and to this Product card.

   Check `factory_list_work_items` first so you never file the same item twice. If a call fails, report it and continue with the others. Do not retry blindly.
5. **Record.** Add a *Work items* section to the spec listing each filed card, commit it (`docs(spec): <title>, work items`), and push with `source_control_push_branch`.
6. **Hand off.** Post the list of filed cards in the session, then move this card to `breakdown-review` with `factory_transition_work_item`.

## Revisions

When the card comes back from `breakdown-review`, fix what the person points out. File missing items and comment on items to change; never delete cards yourself. Then hand off again.

## Never

- Never start runs on the filed cards. People start them on the Work board.
- Never merge the documents' change request.
- Never copy content from one private repository into another, or into a public one.
