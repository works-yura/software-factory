# v4

Окреме дерево поруч із `v3`, на один рівень вище. `v3` лишається довідником і не імпортує ці пакети.

| Пакет | Тека | Що це |
| --- | --- | --- |
| **Рушій** | | |
| `@factory/core` | `packages/core` | Factory engine: define a pipeline, move a card, resolve the decision. Work and Review live in @factory/pipelines. |
| `@factory/pipelines` | `packages/pipelines` | Work and Review pipelines for the conveyor. |
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
| `@factory/integration-github` | `packages/integration-github` | GitHub integration: app or access token (no App), PAT, webhooks, rules, reconcilers, routes, platform-mode adapter. |
| `@factory/integration-gitlab` | `packages/integration-gitlab` | GitLab integration: API, webhooks, rules, reconcilers, merge requests, routes, platform-mode adapter. |
| `@factory/integration-clickup` | `packages/integration-clickup` | ClickUp за polling (API-токен у env, без вебхука): Lists і маршрути налаштовуються в Settings › Intake; задачі → картки, закриття → перенесення картки. |
| **Агент і нагляд** | | |
| `@factory/harness` | `packages/harness` | Agent harness contract: the sessions, runs, events and human gates the runtime drives, independent of any agent framework. |
| `@factory/harness-mastra` | `packages/harness-mastra` | Mastra harness (implements `@factory/harness` over Mastra Code's AgentController): start coordinator, phase-state processor, agent tools, workspace and skills, environment builds. |
| `@factory/harness-claude-code` | `packages/harness-claude-code` | Claude Code harness: runs Factory sessions on the official `claude` CLI (`-p --output-format stream-json --resume`), plan approval through its own `submit_plan` gate (a bundled stdio MCP server; planning runs with file edits denied, not in the CLI's plan mode), isolated from the person's `~/.claude` by default (`--setting-sources project,local`, `--strict-mcp-config`, optional per-session `CLAUDE_CONFIG_DIR`), per-turn credentials, rate-limit classification. Not wired into the server yet. |
| `@factory/harness-claude-code-ui` | `packages/harness-claude-code-ui` | Claude Code sessions in the chat: records the transcript as Mastra thread messages (user signals, one assistant message per stretch of work with text, thinking and tool calls, the plan as a `submit_plan` card), streams it as agent-controller events, and answers the agent-controller session routes (history, stream, send, abort, plan answer) for Claude sessions behind the session access guard. The server mounts it; sessions are attached through `MastraFactory.claudeSessionUi`. |
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
  tool-rules.ts          реакція на результат інструмента агента (лише Work)
shared/work-item-branch.ts   назви гілок і номери PR/MR для Work і Review
```

Нова дошка — нова тека й один рядок у `createPipelines` (вбудовані) або в `boards: [...]` хоста (`boards` у `apps/server/src/mastra/index.ts`).

### Work

Баги й фічі йдуть однією дошкою Work, як в оригіналі Mastra Factory. Тип задачі задає тріаж (`triageType`), а не окрема дошка.

| Фаза | Вид, роль | Що робить |
| --- | --- | --- |
| `intake` | resting | сюди потрапляє картка; нічого не запускає |
| `triage` | working, `triage` | скіл `factory-triage`: класифікація. Баг іде в Planning сам, решта чекає людину |
| `planning` | working, `work` | скіл `factory-plan`. Без затвердженого плану агент не перейде в `execute`, якщо не ввімкнено `autoApprovePlans` |
| `execute` (Building) | working, `work` | промпт білдера: реалізувати план, далі PR або self-review |
| `review` | working, `work` | self-review (`factory-self-review`), якщо ввімкнено; далі PR |
| `done` / `canceled` | terminal | `done` — після merge PR або закриття issue |

Поведінка, що раніше трималася на id `work`, винесена в оголошення дошки: `changeRequests: { build, review, merged }` і `triageClassification: true`.

### Кілька репозиторіїв: одна робоча тека

Factory може мати кілька репозиторіїв (наприклад, бек і застосунок). Усі, що увімкнені в Налаштуваннях → Середовище, клонуються в одну пісочницю на гілку сесії, а сесія працює в теці, яка їх містить. Головного репозиторію немає.

- **Картка без репозиторію** (ручна, з ClickUp) працює в усьому середовищі: ніхто не вибирає репо ні при старті, ні при переносі. Рядок сесії записано під першим репо середовища, але це лише облік. Агент отримує список `Workspace repositories` і змінює ті репо, яких стосується задача.
- **Картка з репозиторієм** (issue або PR з GitHub/GitLab) працює як раніше: `Target repository` — репо, звідки вона прийшла, решта середовища поруч.
- **Інструменти:** для картки на все середовище `source_control_*` не мають репо за замовчуванням, тож `repository` обов'язковий. Self-review передає `reviewedHeads` (head кожного репо), і кожен PR/MR відкривається лише з затвердженого head свого репо.
- **Злиття:** картка тримає список відкритих PR/MR (`openChangeRequests`, по одному на репо) і переходить у Done, коли змерджено всі. Номер `!5` в одному проєкті й `!5` в іншому — різні записи. MR із проєкту, що не є джерелом intake, теж відстежується для картки.
- **Claude Code** клонує всі репо середовища так само (`server/src/claude/checkout.ts`).
- Діалог вибору репо лишився тільки в «Потребує вас», для автоматики, якій нема на чому працювати: кілька репо підключено, але жоден не увімкнено в середовищі.

## Запуск

```sh
corepack pnpm install
corepack pnpm --filter @factory/app-ui build      # UI → apps/ui/dist
cd apps/server && corepack pnpm dev:local          # http://localhost:5874
```

`dev:local` — локальний режим без входу (`FACTORY_LOCAL_DEV_AUTH=1`), база `~/.mastracode/factory-v4/mastra.db` (окремо від v3), пісочниці на цій машині. Налаштування інтеграцій — у `apps/server/.env` (у git не потрапляє); схема змінних — `apps/server/.env.schema`. Перевіряти лише на тестовому репозиторії.

### GitHub без App

`GITHUB_ACCESS_TOKEN` у `apps/server/.env` (група `GITHUB_APP_*` порожня) вмикає `GithubTokenIntegration` (`packages/integration-github/src/token-integration.ts`): токен акаунта, що може пушити в потрібні репозиторії (classic `repo` або fine-grained з read/write на Contents, Issues, Pull requests, Commit statuses).

- «Connect GitHub» реєструє акаунт токена (`GET /user`) як єдине встановлення, без OAuth; у пікері — репозиторії, куди акаунт може пушити.
- Токен підключає одна організація: `GITHUB_ACCESS_TOKEN_ORG_ID` або перша, що натиснула Connect; іншим відмовлено.
- Відкликаний токен (401) пишеться в лог один раз; діагностика показує `tokenRejected`.
- API, clone/push і `GH_TOKEN` у пісочниці — з цим токеном.
- Webhook-ів нема: нові й закриті issues і merge PR ловить опитування, кожні 2 хв (`MASTRACODE_GITHUB_RECONCILE_INTERVAL_MS`). Коментарі й рев'ю в GitHub не доходять — відповідати фабриці через UI.
- Перевірки — commit statuses (check runs доступні лише App).
- З власним токеном людини фабрика пише від її імені, тому себе за логіном не впізнає: свої PR — за міткою provenance, свій коментар тріажу — за міткою й логіном. GitHub не дає схвалити власний PR: рев'ю фабрики на її PR — лише коментар, якщо в Settings не задано окремий PAT рев'ювера.

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
