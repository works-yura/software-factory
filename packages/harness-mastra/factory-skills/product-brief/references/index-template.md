# features/INDEX.md template

Path: `<docs>/features/INDEX.md`. Create it with the first area or change; afterwards only update rows. A Product phase adds or updates **its own change's row** without asking; it never touches another change's row.

````markdown
# <Project>: areas and changes

> **Source of truth:** `features/<area>/design.md` is how each area works now. A change is proposed in
> `changes/<YYYY-MM-DD>-<change>/` as a delta, and merged into the area when it ships. One Product card per change;
> its Development cards are projections of the change's `tasks.md`, one card per task, linking back to
> `changes/<change>/tasks.md#<task-id>`. Change the plan there first.

## Areas
| Area | Spans (repositories) | Truth | Status |
|---|---|---|---|
| Payments | api, mobile | features/payments/design.md | baseline / current |

## Changes in flight
| Change | Areas | Status | Revision | Depends on | Product card |
|---|---|---|---|---|---|
| 2026-11-10-subscriptions | payments, auth | draft | 1 | — | <link> |

Status: `research` → `draft` → `in-approval` → `approved` (brief) → `designed` → `premortem-done` → `phased` → `in-progress` → `shipped` → `archived` (delta merged into the areas, folder moved to `changes/archive/`).

## Cross-change dependencies
- <change> depends on <change> (<why: user identity, an entity, a contract>)

## Foundation resources
| Resource | Owning task | Used by |
|---|---|---|

## Sources
- `blackbox/sources/<file>` (or `blackbox/artifacts/<file>`) — <what it is> — read <date>

## Open questions (project-wide)
- <question> — blocks: <changes>
````
