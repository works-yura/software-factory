# features/INDEX.md template

Path: `<docs>/features/INDEX.md`. Create it with the first area or change; afterwards only update rows.

````markdown
# <Project>: areas and changes

> **Source of truth:** `docs/features/<area>/design.md` is how each area works now. A change is proposed in
> `docs/changes/<YYYY-MM-DD>-<change>/` as a delta, and merged into the area when it ships. Board cards (Product and
> Development) are projections of a change's `tasks.md`, one card per task, linking back to
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
