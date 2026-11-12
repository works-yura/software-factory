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
| `@factory/auth` | `packages/auth` | Factory auth: provider-neutral auth gate and routes, signed OAuth state. |
| `@factory/auth-better-auth` | `packages/auth-better-auth` | Google sign-in, organizations and invitation links on better-auth (copy of `@mastra/auth-better-auth`). |
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
| `@factory/integration-clickup` | `packages/integration-clickup` | ClickUp за polling (без вебхука): API-токен кожна організація підключає в Налаштування › Підключення (ADR-0032), Lists — маршрути надходження; задачі → картки, закриття → перенесення картки. |
| **Агент і нагляд** | | |
| `@factory/harness` | `packages/harness-core` | Agent harness contract: the sessions, runs, events and human gates the runtime drives, independent of any agent framework. |
| `@factory/harness-mastra` | `packages/harness-mastra` | Mastra harness (implements `@factory/harness` over Mastra Code's AgentController): start coordinator, phase-state processor, agent tools, workspace and skills, environment builds. |
| `@factory/harness-claude-code` | `packages/harness-claude-code-core` | Claude Code harness: runs Factory sessions on the official `claude` CLI (`-p --input-format stream-json --output-format stream-json --resume`, stdin kept open so a steer joins the turn in flight and an MCP server's elicitation is asked as a question card while its turn waits), plan approval through its own `submit_plan` gate (a bundled stdio MCP server; planning runs with file edits denied, not in the CLI's plan mode), isolated from the person's `~/.claude` by default (`--setting-sources project,local`, `--strict-mcp-config`, optional per-session `CLAUDE_CONFIG_DIR`), per-turn credentials, rate-limit classification. Not wired into the server yet. |
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
  board.ts               фази з виконавцями (runner: скіл, контекст, мета), переходи, політика переходів
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
| `execute` (Building) | working, `work` | скіл `factory-build`: реалізувати план, відкрити PR і перенести картку в Review |
| `pr-review` (Review) | working, `review` | скіл `factory-review`: рев'ю PR картки |
| `done` / `canceled` | terminal | `done` — після merge PR або закриття issue |

Цикл PR читається з фаз дошки, а не з її id чи ключів (`boardFlow`): рев'ю PR — перша робоча фаза в контексті `review` з інструментом `factory_review_source`; self-review — інша фаза `review` лише з `factory_record_review_verdict`; будівник — остання робоча фаза, що веде в рев'ю; merge закриває картку в `sourceClosed.completed` (інакше в першій термінальній фазі). Тож цикл PR може вести будь-яка дошка.

Self-review у Work за замовчуванням більше немає (upstream #29724): нова Work — Intake → Triage → Planning → Building → Review (`pr-review`) → Done. Дошка, якій він потрібен, додає робочу фазу в контексті `review`, що дає лише `factory_record_review_verdict`; перемикач self-review у проєкті й рядок `Self-review:` у сигналі є лише на таких дошках. Проєкти, збережені раніше, мають у своєму рядку Work фазу `review` і далі її запускають; щоб прибрати її, відредагуйте дошку Work. Сигнал `factory-phase` додає рядок `Board phases by part:`, за яким скіли переносять картку. Окремо дошка може оголосити `triageClassification: true`.

### Кілька репозиторіїв: одна робоча тека

Factory може мати кілька репозиторіїв (наприклад, бек і застосунок). Усі, що увімкнені в Налаштуваннях → Середовище, клонуються в одну пісочницю на гілку сесії, а сесія працює в теці, яка їх містить. Головного репозиторію немає.

- **Картка без репозиторію** (ручна, з ClickUp) працює в усьому середовищі: ніхто не вибирає репо ні при старті, ні при переносі. Рядок сесії записано під першим репо середовища, але це лише облік. Агент отримує список `Workspace repositories` і змінює ті репо, яких стосується задача.
- **Картка з репозиторієм** (issue або PR з GitHub/GitLab) працює як раніше: `Target repository` — репо, звідки вона прийшла, решта середовища поруч.
- **Інструменти:** для картки на все середовище `source_control_*` не мають репо за замовчуванням, тож `repository` обов'язковий. Self-review передає `reviewedHeads` (head кожного репо), і кожен PR/MR відкривається лише з затвердженого head свого репо.
- **Злиття:** картка тримає список відкритих PR/MR (`openChangeRequests`, по одному на репо) і переходить у Done, коли змерджено всі. Номер `!5` в одному проєкті й `!5` в іншому — різні записи. MR із проєкту, що не є джерелом intake, теж відстежується для картки.
- **Claude Code** клонує всі репо середовища так само (`server/src/claude/checkout.ts`).
- Діалог вибору репо лишився тільки в «Потребує вас», для автоматики, якій нема на чому працювати: кілька репо підключено, але жоден не увімкнено в середовищі.

### Одна тека пісочниці на картку

Усі сесії однієї картки (triage, work: planning, building, rework; review) працюють в одній теці: `<корінь пісочниць>/work-items/<factory>/<гілка картки>`. Перша сесія клонує середовище й виконує setup-команди, наступні беруть ту саму теку й checkout без нового клону й setup. Сесії й треди лишаються окремими на роль; спільний лише диск. Сесія без картки має свою теку `<корінь>/<sessionId>`, як раніше. Upstream дає кожній сесії свою пісочницю (`MIGRATION.md`, «Одна тека пісочниці на картку»).

- **Котра тека:** сесія на гілці картки (`workItemBranch`, з id або суфіксом картки) — тека цієї гілки; сесія на власній гілці (`user/session-…`, запущена `factory_start_session`) — тека картки, до якої її прив'язав запуск. Тека виводиться з рядка сесії й картки при кожному розв'язанні, зі сховища не читається (`session/src/work-item-folders.ts`).
- **Гілка:** сесії автоматики й кнопки Start уже на гілці картки, тож checkout спільний. Сесія з власною гілкою, що приходить у теку картки, створює свою гілку від поточної гілки теки (з комітами й незакоміченими файлами попередньої ролі), а не від бази; так само в інших репо середовища (`inheritCheckout`).
- **Час життя:** зупинка чи retire однієї сесії зупиняє лише її процеси. Теку видаляють термінальна стадія картки, видалення картки або видалення її останньої сесії; teardown-команди виконуються один раз на теку.
- **Одночасність:** дві ролі картки не працюють у теці разом. Диспетчер відкладає запуск ролі, поки йде запуск в іншій сесії картки; кнопка Start і `factory_start_session` відмовляють (`card_session_running`), поки інша сесія картки працює.
- Лише для `LocalFactorySandbox`; власна пісочниця хоста (callback) лишається по сесії.

## Запуск

```sh
corepack pnpm install
corepack pnpm --filter @factory/app-ui build      # UI → apps/ui/dist
cd apps/server && corepack pnpm dev:local          # http://localhost:5874
```

`dev:local` — сервер на цій машині з входом через Google (`FACTORY_AUTH=google`), база `~/.mastracode/factory-v4/mastra.db` (окремо від v3), пісочниці на цій машині. Налаштування — у `apps/server/.env` (у git не потрапляє); схема змінних — `apps/server/.env.schema`. Перевіряти лише на тестовому репозиторії.

### Вхід через Google

Єдиний вхід (і в `dev:local`, і на сервері — `FACTORY_AUTH=google`): кнопка «Увійти через Google», кожен новий користувач отримує свою організацію, інших додають посиланням-запрошенням з «Налаштування › Організація» ([docs/features/auth](docs/features/auth/design.md), [ADR-0030](docs/adr/0030-google-sign-in-organizations-invite-links.md)). У `apps/server/.env`:

| Змінна | Що |
| --- | --- |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | OAuth-клієнт Google (тип «Web application»); redirect URI — `<MASTRACODE_PUBLIC_URL>/auth/api/callback/google` |
| `FACTORY_AUTH_SECRET` | підпис cookie сесії, ≥ 32 символи (`openssl rand -base64 32`); зміна виводить усіх |
| `MASTRACODE_PUBLIC_URL` | адреса, яку бачить браузер (у `dev:local` типово `http://localhost:5874`) |

Бракує обов'язкової змінної — сервер не стартує й називає її.

### GitHub: App або токен

Кожна організація підключає GitHub у Налаштування › Підключення › «Додати підключення» ([ADR-0034](docs/adr/0034-github-app-or-token-per-connection.md)): «GitHub» — через App сервера (лише коли задано всю групу `GITHUB_APP_*`), «GitHub · токен» — персональний токен, який вставляє адміністратор організації (classic `repo` або fine-grained з read/write на Contents, Issues, Pull requests, Commit statuses; Workflows — якщо агенти правлять CI). Токен перевіряється (`GET /user`) і зберігається зашифровано; env не потрібен. Обидва способи можуть бути в одній організації. Для токен-підключень:

- У пікері — репозиторії, куди акаунт токена може пушити.
- `GITHUB_ACCESS_TOKEN` у `apps/server/.env` — необов'язковий запасний: обслуговує підключення, які зареєстрував колишній режим токена сервера (id його акаунта), доки адміністратор не замінить токен; може стояти разом із `GITHUB_APP_*`. `GITHUB_ACCESS_TOKEN_ORG_ID` більше не читається.
- Відкликаний токен (401) пишеться в лог один раз; діагностика показує `fallbackTokenRejected` для запасного.
- API, clone/push і `GH_TOKEN` у пісочниці — з токеном підключення.
- Webhook-ів нема: нові й закриті issues і merge PR ловить опитування, кожні 2 хв (`MASTRACODE_GITHUB_RECONCILE_INTERVAL_MS`). Коментарі й рев'ю в GitHub не доходять — відповідати фабриці через UI.
- Перевірки — commit statuses (check runs доступні лише App).
- З власним токеном людини фабрика пише від її імені, тому себе за логіном не впізнає: свої PR — за міткою provenance, свій коментар тріажу — за міткою й логіном. GitHub не дає схвалити власний PR: рев'ю фабрики на її PR — лише коментар, якщо в Settings не задано окремий PAT рев'ювера.

| Застосунок | Тека | Що це |
| --- | --- | --- |
| `@factory/app-server` | `apps/server` | Хост: `MastraFactory` з GitHub і GitLab, локальний вхід і вхід через Google, сценарні тести хоста |
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
