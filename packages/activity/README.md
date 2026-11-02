# @factory/activity

Everything the Factory **Activity** page was made of, in one place:

- `src/` — the attention inbox routes (`/web/factory/projects/:id/attention`, read, archive, restore, read-all) and their providers: failed and proposed decisions, runs parked on an agent's question, followed discussions. Live: `WorkItemRoutes` (`@factory/api`) still mounts them, and `@factory/runtime` attention providers keep feeding agents and MCP. Its route tests stay in `packages/api/src/attention.test.ts` because they drive the routes through `WorkItemRoutes`.
- `ui/` — the retired page, **parked**: not built, not typechecked, not tested. Paths mirror `apps/ui/`, so `ui/src/ui/pages/ActivityPage.tsx` came from `apps/ui/src/ui/pages/ActivityPage.tsx`. It holds the page, the sidebar link with its unread badge and chime, the Needs you / followed-discussion lists, the timeline and Codebase views, their hooks and services, their tests, and `e2e/ui/attention.ts`.

## Why it is off

Upstream Mastra retired the page on 2026-10-23 (`63d7d5cbd4 feat(factory): retire Activity page and notifications (#28257)`); the commit, changeset and README say what went, not why. v4 follows it: no sidebar link, badge, chime or search entry, and `/activity`, `/overview`, `/attention`, `/metrics`, `/audit` open the Factory's board. Board cards keep failed-decision retries and proposal approval and dismissal; session rows keep the Ready indicator and completion sound.

## Bringing it back

`ui/` also keeps the full pre-retirement copies of the files the app slimmed down: `src/ui/domains/factory/activity.ts` (+ its test), `auditPresentation.ts`, `services/attention.ts`, `services/audit.ts` and `src/hooks/useAuditEvents.ts`. To restore:

1. Move every file under `ui/` back to the same path under `apps/ui/`, overwriting the slim copies.
2. Re-add what the retirement removed from the app's wiring: `SidebarActivityLink` in `AppSidebar.tsx` (and the `nav.footer` label), the `ActivityPage` route and `ActivityRedirect` in `router.tsx`, the Activity and Audit log entries in `GlobalSearchNavigationResults.tsx`, the `githubCommits`, `factoryAttentionRoot`, `factoryAttention` and `factoryAuditPortal` query keys, the attention invalidation in `FeedEventsProvider.tsx` and `useFactoryDecisions.ts`, `activity` in `PRESERVED_FACTORY_ROUTE` (`factoryPaths.ts`) and the attention handler in `e2e/ui/msw-server.ts`.

Reverting the retirement commit does both at once.
