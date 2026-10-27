# v4

Окреме дерево поруч із `v3`, на один рівень вище. `v3` лишається довідником і не імпортує ці пакети.

| Пакет | Тека | Що це |
| --- | --- | --- |
| **Рушій** | | |
| `@factory/core` | `packages/core` | Factory engine: define a pipeline, move a card, resolve the decision. Work, Review, Acceptance, and Bug live in @factory/pipelines. |
| `@factory/pipelines` | `packages/pipelines` | Work, Review, Acceptance, and Bug pipelines for the conveyor. |
| **Сховище і рантайм** | | |
| `@factory/store` | `packages/store` | Card, decision, and run-binding storage on Mastra storage domains (libsql, pg). |
| `@factory/runtime` | `packages/runtime` | Moves cards: transition service, decision dispatcher, run audit, terminal cleanup. |
| `@factory/work-items` | `packages/work-items` | Create work items through the transition service; act on deferred decisions. |
| `@factory/testing` | `packages/testing` | Test seams for suites copied from v3: Work and Review installed by default, libsql storage. |
| **Основа** | | |
| `@factory/capabilities` | `packages/capabilities` | Capability contracts integrations implement: connection, intake, version control. |
| `@factory/observability` | `packages/observability` | Request timing and product telemetry. |
| `@factory/http` | `packages/http` | HTTP route helpers, server errors, SPA static serving. |
| `@factory/auth` | `packages/auth` | Factory auth: WorkOS/Studio providers, platform auth host, signed OAuth state. |
| `@factory/contracts` | `packages/contracts` | Wire contracts of the Factory HTTP API, shared by server and UI. |
| `@factory/credentials` | `packages/credentials` | Provider and tenant model credentials, provider display names. |
| `@factory/feed` | `packages/feed` | Work-item feed over HTTP: audit and comments domains, wire formats, feed events. |
| `@factory/sandbox` | `packages/sandbox` | Session sandboxes: local and callback sandboxes, workdirs, setup gates, materialization, git in the sandbox, retirement. |
| `@internal/workspace` | `packages/internal-workspace` | Workspace file commands, repo clone, setup marker (from v3 packages/internal-workspace). |
| **Сесії й інтеграції** | | |
| `@factory/session` | `packages/session` | Factory sessions: hydration, credential policy, threads, capture processors, session access, Supervisor session identity. |
| `@factory/integrations` | `packages/integrations` | Integration contract (IntegrationContext, Integration), issue reconcilers, subscription sessions, platform API client and connect routes. |
| `@factory/integration-github` | `packages/integration-github` | GitHub integration: app, PAT, webhooks, rules, reconcilers, routes, platform-mode adapter. |
| `@factory/integration-gitlab` | `packages/integration-gitlab` | GitLab integration: API, webhooks, rules, reconcilers, merge requests, routes, platform-mode adapter. |
| **Агент і нагляд** | | |
| `@factory/harness-mastra` | `packages/harness-mastra` | Mastra harness: start coordinator, phase-state processor, agent tools, workspace and skills, environment builds. |
| `@factory/supervisor` | `packages/supervisor` | Supervisor: health checks and worker, read and write tools, session messaging, instructions. |
| **API і сервер** | | |
| `@factory/mcp` | `packages/mcp` | MCP surface: the Factory's MCP endpoint for Claude, ChatGPT and other MCP clients (OAuth as the signed-in user, the agent tools injected by the host), `factory.activity` events. |
| `@factory/api` | `packages/api` | Factory HTTP API: projects, work items, attention, config, intake, source control, supervisor, surface, telemetry routes; metrics. |
| `@factory/server` | `packages/server` | MastraFactory: assembles runtime, storage, harness, integrations (GitHub, GitLab), API, and Supervisor; holds the cross-layer system tests. |

Залежності йдуть лише згори вниз (таблиця — від нижчих шарів до вищих); циклів між пакетами нема. Інтеграції: GitHub і GitLab.

Хост ставить дошки так:

```ts
import { createPipelines } from '@factory/pipelines';

const boards = createPipelines();
```

Реєстр без Work і Review: `createBoardRegistry({ boards: [...] })` з `@factory/core`.

У `@factory/pipelines` кожна дошка має свою теку однакової форми:

```
<board>/
  board.ts               фази, переходи, підключення правил
  phase-rules.ts         onEnter: яку сесію агента запустити
  transition-policy.ts   хто і куди може перенести картку
  tool-rules.ts          реакція на результат інструмента агента (лише Work; Bug бере правила Work)
shared/work-item-branch.ts   назви гілок і номери PR/MR для Work і Review
```

Нова дошка — нова тека й один рядок у `createPipelines` (вбудовані) або в `boards: [...]` хоста (`apps/server/src/mastra/index.ts`: `[acceptanceBoard, bugBoard]`).

### Дошка Bug

`bugBoard` (`packages/pipelines/src/bug`) — окремий конвеєр для багів; Work лишається як є.

| Фаза | Вид, роль | Що робить |
| --- | --- | --- |
| `intake` | resting | сюди потрапляє картка; нічого не запускає |
| `triage` | working, `triage` | скіл `bug-triage`: чи це баг, severity. Не баг — `canceled` з причиною й назвою потрібної дошки (картка не міняє дошку) або `intake` для людини |
| `planning` | working, `plan` | скіл `bug-plan`: як відтворити (кроки, який падаючий тест і де) і як виправити. Далі — `tests`; агент не пройде туди без затвердженого плану, якщо не ввімкнено `autoApprovePlans` |
| `tests` (Reproduction test) | working, `tester` | скіл `bug-test`, окреме місце: лише падаючий тест за планом, окремий коміт, `factory_record_reproduction_test` записує в картку `bugReproTestSha` і `bugReproTestPaths`. Не відтворився — звіт і `intake`. У `execute` агент потрапляє лише звідси із записаним тестом (або назад з `review`) |
| `execute` (Fix) | working, `work` | скіл `bug-build`: фікс до зеленого тесту й перевірок з `AGENTS.md`, тестові файли не чіпає. Виходить лише через `review` |
| `review` | working, `work` | self-review (`factory-self-review`), якщо ввімкнено; далі PR (без self-review білдер відкриває PR уже з `review`) |
| `done` / `canceled` | terminal | `done` — після merge PR або закриття issue |

Перевірка тесту детермінована: `factory_transition_work_item` (`harness-mastra/src/rules/reproduction-test.ts`) відхиляє перехід місця `work` з `execute` у робочу фазу, якщо `git diff --name-only --no-renames <bugReproTestSha>` у чекауті сесії зачіпає записані шляхи; якщо чекаут не прочитати — теж відмова. Політика дошки тут не підходить: вона чиста, без пісочниці й з таймаутом 5 с. Перехід у `intake` (віддати людині) не перевіряється.

Скіли не знають стека: як збирати, запускати, тестувати й відтворювати на конкретній платформі (admin, mobile Flutter, server), вони читають з `AGENTS.md` і скілів репозиторію (`.agents/skills`, `.claude/skills`).

Як направити issue на Bug: Settings › Intake › GitHub routing, мітка `bug` → дошка `bug` (`PUT /web/intake/label-routes`). Мітки без урахування регістру; issue без маршруту йдуть у Work. Додавання чи зняття мітки переносить картку між Bug і Work, поки її не взяв агент.

Поведінку Work, що раніше трималася на id `work`, винесено в оголошення дошки: `changeRequests: { build, review, merged }` (PR відкрито → картка в `review` і картка Review; merge → `done`; фідбек на PR будить білдера; self-review і `selfReviewEnabled`), `triageClassification: true` (triage звітує `triageType`) і `reproductionTest: { record, protect }` (запис і захист тесту). Досі лише для Work: повторний triage після редагування issue чи коментаря (`factory-triage`), утримання класифікованого не-бага в Supervisor, мітки `needs approval` на вході, скіли дошки в Settings › Skills (для Bug видно лише ролі), метрики Overview. Захист тесту не покриває пуші після переходу в `review` (відповіді на фідбек PR): там тест перевіряє self-review і рев'ю PR.

## Запуск

```sh
corepack pnpm install
corepack pnpm --filter @factory/app-ui build      # UI → apps/ui/dist
cd apps/server && corepack pnpm dev:local          # http://localhost:5874
```

`dev:local` — локальний режим без входу (`FACTORY_LOCAL_DEV_AUTH=1`), база `~/.mastracode/factory-v4/mastra.db` (окремо від v3), пісочниці на цій машині. Налаштування інтеграцій — у `apps/server/.env` (у git не потрапляє); схема змінних — `apps/server/.env.schema`. Перевіряти лише на тестовому репозиторії.

| Застосунок | Тека | Що це |
| --- | --- | --- |
| `@factory/app-server` | `apps/server` | Хост: `MastraFactory` з GitHub і GitLab, локальний вхід, сценарні тести хоста |
| `@factory/app-ui` | `apps/ui` | Веб-UI (React, Vite); бере з пакетів лише легкі модулі через підшляхи (`@factory/core/rules/types` тощо), щоб серверний код не потрапив у бандл |

## Збірка

Збірки нема. Пакети експортують `src/index.ts`, імпорти всередині мають розширення `.ts`, синтаксис лише той, що стирається (`erasableSyntaxOnly`). Node ≥ 22.18 запускає код напряму, `tsc` з `rewriteRelativeImportExtensions` перепише імпорти, якщо колись знадобиться emit.

```sh
pnpm check   # tsc --noEmit, разом із тестами
pnpm test    # vitest
```

## Що далі

Код перенесено з v3 копією, тести — 1:1 (`pnpm verify` звіряє кількість). Журнал швів — `MIGRATION.md`.

1. Борг типів у тестах (`scripts/test-type-debt.sh`): закривати по пакетах.
2. ~~Прибрати словник Linear/Jira/incident.io з `core` і `pipelines`.~~ Зроблено (`MIGRATION.md`, «Словник Linear/Jira/incident.io»).
3. Порт харнесу: відв'язати `harness-mastra` від GitHub (PAT у `workspace`) і від Mastra в `runtime` (`FactoryController`, `DispatcherSession`).
4. Порти сховища, потім Firestore.
