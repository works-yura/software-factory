# specify/INDEX.md template

Path: `<docs>/specify/INDEX.md`. Create it with the first feature; afterwards only update rows.

````markdown
# <Project>: plan index

> **Source of truth:** `docs/specify/` is canonical. Board cards (Product and Development) are projections of
> `tasks.md`, one card per task, linking back to `specify/<feature>/tasks.md#<task-id>`. Change the plan here first.

## Sources
- `raw/<file>` — <what it is> — read <date>

## Features
| Feature | Slug | Status | Revision | Depends on | Product card |
|---|---|---|---|---|---|
| Sign-in | auth | draft | 1 | — | <link> |

Status: `research` → `draft` → `in-approval` → `approved` (brief) → `designed` → `premortem-done` → `phased` → `in-progress` → `shipped`.

## Cross-feature dependencies
- <feature> depends on <feature> (<why: user identity, an entity, a contract>)

## Foundation resources
| Resource | Owning task | Used by |
|---|---|---|

## Open questions (plan-wide)
- <question> — blocks: <features>
````
