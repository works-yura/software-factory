# Міграція v3 → v4

Код переноситься з `v3/packages/factory/src` копією. Нове пишеться тільки на швах: порт, тестова обгортка, тип замість важкого імпорту. Кожен шов — окремий коміт і рядок нижче.

Перевірка кроку: `pnpm verify` (типи разом із тестами, тести, звірка кількості тестів з v3 за `migration/test-pairs.tsv`).

## Перенесено

| v3 | v4 |
| --- | --- |
| `boards/{define-board,registry,semantics,relocate,transition-policy}.ts`, `rules/{types,validation,resolve,event-rules}.ts` | `core/src/boards`, `core/src/rules` |
| `boards/{work,review,work-tool-rules,work-transition-policy}.ts`, `work-item-branch.ts` | `pipelines/src/{work,review,shared}` |
| `storage/domains/work-items/{base,board-version}.ts` | `store/src/work-items` |
| `storage/domains/audit/{base,actions,actors}.ts` | `store/src/audit` |
| `storage/domains/comments/{base,activity,actor,feed-context,schema}.ts` | `store/src/comments` |
| `rules/dispatch-errors.ts` | `store/src/dispatch-errors.ts` |
| `storage/domains/{projects,intake,credentials,source-control,integrations,model-defaults,memory-settings,custom-providers,channel-identity,queue-health,filesystem}` | `store/src/<domain>` |
| `secret-encryption.ts`, `storage/test-utils.ts` | `store/src/secret-encryption.ts`, `store/src/testing.ts` |
| `rules/{transition-service,dispatcher,decision-applicability,terminal-cleanup}.ts` | `runtime/src` |
| `session/run-audit.ts`, `skills/service.ts`, `routes/attention-providers.ts` | `runtime/src` |

| решта `v3/packages/factory/src` (383 файли: integrations, routes, session, tools, sandbox, environment, supervisor, mcp, auth, workspace, `factory.ts`, …) | `platform/src`, та сама структура |
| `v3/packages/internal-workspace/src` | `internal-workspace/src` (`@internal/workspace`) |
| `factory-skills/`, `scripts/generate-api-cli-route-metadata.ts` | `platform/factory-skills`, `platform/scripts` |

`@factory/platform` (тепер `@factory/server`) — проміжний пакет («душитель»): уся решта v3 одним шматком, підключена до вже винесених пакетів. Пакети виносяться з нього по одному, кожен крок перевіряє `pnpm verify`.

## Винесено з platform

| Пакет | Модулі |
| --- | --- |
| `@factory/capabilities` | `capabilities/{connection,intake,version-control}` |
| `@factory/observability` | `timing`, `telemetry`, `telemetry-types` |
| `@factory/sandbox` | `sandbox/{session-sandbox,workdir,git-ref,local-factory-sandbox,callback-factory-sandbox,materialization}` |

Винос робить `migration/tools/extract-package.py`: `git mv`, перешивання імпортів і `vi.mock`, маніфест із версіями з `platform`, оновлення `test-pairs.tsv`. Модуль, що імпортує щось із `platform`, інструмент не переносить.

## Застосунки

| v3 | v4 | Шви |
| --- | --- | --- |
| `apps/server` | `apps/server` (`@factory/app-server`) | імпорти на `@factory/server` і пакети інтеграцій; Linear, Jira, incident.io, Slack прибрано з проводки й тестів хоста (`index.test` −14); дошка Acceptance — з `@factory/pipelines`; скрипти через `corepack`; база `factory-v4`; скіли з `harness-mastra/factory-skills` |
| `apps/ui` | `apps/ui` (`@factory/app-ui`) | глибокі імпорти `@eclipt/factory/*` → підшляхи пакетів (`./*` у `exports`); TypeScript 6 з каталогу `ts6` (конфіг Vite бере JS API TypeScript); `allowImportingTsExtensions`; тести через `scripts/vitest-isolate-failures.mjs` |

- `pipelines`: повернуто `WorkItemBranchSource` (= `WorkItemSource | 'slack-thread'`), бо UI показує картки з тредів Slack; перше злиття типів цю гілку загубило.
- Тести UI з MSW нестабільні під навантаженням і у v3 (окремо проходять, у повному прогоні щоразу падають інші). `scripts/vitest-isolate-failures.mjs` після повного прогону запускає кожен файл, що впав, окремо; прогін падає, лише якщо файл падає й сам. Повтори в тому ж воркері (`--retry`) не допомагали.

## Прибрані інтеграції

v4 лишає GitHub і GitLab. Linear, Jira, incident.io, Slack і WorkOS прибрано на вимогу (у git історія збережена, коміт «drop integrations»):

- пакети `integration-{linear,jira,incidentio,slack,workos}` видалено разом із тестами (пари тестів прибрано з `test-pairs.tsv`);
- `factory.ts` більше не ставить Platform-версії Linear, Jira, incident.io;
- з наскрізних тестів прибрано кейси, що їх кликали (`default-handlers` −3, `issue-reconciler` −1);
- WorkOS-інтеграцію у v3 ніхто не імпортував; вхід через WorkOS лишається в `@factory/auth`;
- Slack у v3 ставив хост (`apps/server`), не пакет.

### Словник Linear/Jira/incident.io

Власник вирішив: Linear, Jira, incident.io не підтримуються. Прибрано решту словника:

- `core`: джерела `linear-issue`/`jira-issue`/`incidentio-follow-up` і `linearIssue`/`jiraIssue`/`incidentioFollowUp`, `FACTORY_{LINEAR,JIRA,INCIDENTIO}_EVENTS`, контексти правил, ключі `BoardEventRules`, типи ingress;
- `pipelines`: обробники тріажу Work для них, гілки `factory/linear-*`/`jira-*`/`incidentio-*`;
- `store`/`session`/`api`/`harness-mastra`: мапа «проєкт Linear → репозиторій» (`repositoryByLinearProject`, параметр `intake` у `FactoryStartCoordinator` і `prepareFactoryRuleBinding`), заглушки `/web/linear/status`, `/web/jira/status`, провайдери Jira й incident.io в `PLATFORM_CONNECT_PROVIDERS`;
- `apps/server`: змінні `LINEAR_*`, `JIRA_*`, `INCIDENT_IO_API_KEY` у `.env.schema`;
- `apps/ui`: налаштування надходження, фільтр за проєктом Linear, крок онбордингу «Connect your work», дані й іконки Linear/Jira/incident.io;
- скіли `factory-triage`, `factory-plan`, `configure-factory-rules`: GitLab замість Linear.

Збережені картки з такими джерелами не ламаються: `workItemSource` повертає `manual` для невідомої інтеграції, відкладене рішення зі старим джерелом не проходить перевірку і падає як звичайна помилка рішення. Міграції бази нема.

Тести: пакети −7 (`default-handlers` −2, `factory.test` −3, `work-item-branch` −1, `platform-connect-routes` −1); UI −121 (4 файли видалено: −34, решта −88, +1 тест на стару картку). Тести, що перевіряли спільну логіку через Linear, переведено на GitLab/GitHub. `Slack-thread` лишився: UI показує такі картки.

## Не перенесено

| Що | Чому |
| --- | --- |
| `build/rewrite-specifiers.test.ts` | тестує скрипт пакування v3 (tsdown); у v4 збірки нема |
| `internal-workspace/src/files-api-filesystem.test.ts` | потребує `@internal/workspace-test-utils` з монорепо Mastra; у v3 файл теж падає на імпорті й не запускався |

## Шви

| Де | Що змінено | Чому |
| --- | --- | --- |
| `core` реєстр | нема вбудованих Work/Review | рушій не знає конкретних дошок; їх ставить `@factory/pipelines` |
| `runtime/src/test-support.ts` | обгортки `FactoryTransitionService`, `FactoryDecisionDispatcher`, `createFactoryStorageForTests` з `createPipelines()` | у v3 Work/Review підставлялись за замовчуванням |
| `store/src/testing.ts` | реєстр для термінальних фаз — параметр | сховище не знає дошок |
| `store` `WorkItemUpdateConflictError`, `ExternalWorkItemSource` | беруться з core | два класи ламали `instanceof` у `moveCardToBoard` |
| `core` `CardMoveStore.supersedeDecisionsForWorkItem` | `Promise<unknown>` замість `Promise<number>` | сховище повертає записи; рушій значення не читає |
| `core` коди відмови | один масив `FACTORY_RULE_REJECTION_CODES` | у v3 `approval_required` відкидала перевірка рішення |
| `runtime/src/audit-recorder.ts` | інтерфейс `record` замість `Pick<AuditDomain>` | `AuditDomain` тягне hono і маршрути |
| `runtime/src/harness-state.ts` | `HarnessSessionState` замість `MastraCodeState` | runtime лише передає стан; `@mastra/code-sdk` переїде в харнес |
| `runtime/src/skills/rescan.ts` | дві речі з `workspace.ts` | `workspace.ts` тягне GitHub і пісочниці; синхронізація з резолвером переїде в харнес |
| `runtime/src/run-end-report.ts` | лише типи звіту | доставка звіту йде через нотифікації Mastra, переїде в харнес |
| `store/src/supervisor-finding.ts` | копія типу знахідки | `WorkItemsStorage` зберігає знахідки; Supervisor ще не перенесено |
| класи помилок і сервіси | поля замість параметрів-властивостей (`migration/tools/erase-parameter-properties.py`) | `erasableSyntaxOnly`, щоб Node запускав `.ts` напряму |
| `platform/src/boards.ts` | `defaultBoards` і `createDefaultBoardRegistry` з семантикою v3 | хост v3 ставив Work і Review за замовчуванням; рушій v4 цього не робить |
| `platform/src/test-support.ts` | обгортки з дошками за замовчуванням, `createBoardRegistry` з семантикою v3 для тестів | скопійовані тести лишаються без змін |
| `platform/src/factory.test.ts` | три `vi.mock` модулів runtime злиті в один `vi.mock('@factory/runtime')` | у v4 це один пакет |
| `platform/src/rules/processor.ts` | тип опцій винесено в `FactoryPhaseStateProcessorOptions` | був продубльований полем і параметром |
| `platform/src/routes/surface.ts` | `workItemSource` з core замість `workItemBranchSource` | дві однакові функції |
| `routes/contracts.ts`, `rules/tools.ts`, `supervisor/write-tools.ts` | `IDENTIFIER_RE` замість `BOARD_IDENTIFIER_RE` | один регекс, два імені |
| `core`, `pipelines` | повернуто `AUTO_TRIAGED_LABEL`, `normalizeFactoryRuleJsonValue`, `workItemThreadTitle`, `hasRecordedVerdict`, тип `FactoryDismissStaleReviewsDecision` | у першому розрізі їх прибрали як мертві; решта v3 їх використовує |
| кореневий `test` | пакети по черзі (`--workspace-concurrency=1`) | тести зі справжнім git у `platform` вилітають за таймаут, коли пакети йдуть паралельно |

## Борг типів у тестах

`core`, `pipelines`, `store`, `runtime`, `internal-workspace`: тести тайпчекаються, борг нуль.

`platform`: `check` перевіряє лише код, як у v3. `pnpm --filter @factory/platform check:tests` рахує помилки типів у тестах: зараз 794. Борг закривається, коли пакет виходить із `platform`.

`platform/src/session/source-control-tools.test.ts`: блок зі справжнім git отримав таймаут 30 с (у v3 — 5 с за замовчуванням), бо під повним паралельним прогоном окремі кейси йдуть кілька секунд і вилітали.

### Виправлено при перенесенні

У v3 тести не тайпчекались. Виправлено, поведінку тестів не змінено:

- `dispatcher.test.ts`: `failDeferredDecision` з `error` замість `lastError`, без `now` і `failureCode`; моки `reportRunEnd` без результату; `DecisionAttentionProvider` без `boards`; `counts` без `userId`.
- `transition-service.test.ts`, `terminal-cleanup.test.ts`, `run-audit.test.ts`, `comments/base.test.ts`, `work-items/base.test.ts`: неточні типи фікстур.
- `source-control/base.test.ts`: створення сесій без `factoryProjectId`, який тип вимагає. Реалізація це допускає (сховище бере проєкт зі з'єднання), тому фікстури йдуть через `fixtureSession`, а тип для продакшн-викликів лишився обов'язковим.
- `integrations/base.test.ts`, `credentials/base.test.ts`: тип даних підписки і мок `decrypt`.
- `pipelines` тести: `'issue'` замість `'github-issue'`, `id` замість `bindingId` в актора.

## Перенесено з upstream після 4c22623ea3

| Коміт | Що | Куди | Відхилення |
| --- | --- | --- | --- |
| `7e428dc80e` (#28052) | інструмент `factory_recreate_sandbox`, `SessionRetirementCoordinator.resetSessionSandbox()`, `clearFailedSetupCommands` | `sandbox/src/{session-retirement,session-sandbox}.ts`, `harness-mastra/src/tools/{sandbox-tools,permissions}.ts`, `server/src/factory.ts` | інструмент лише на `platform`, як в upstream. Local не вмикаємо: `LocalSandbox.destroy()` лишає робочу теку, тож після скидання лишаються checkout, незакомічені файли й маркер setup (це фіксує тест «on a LocalFactorySandbox»). E2B не вмикаємо: справжнього провайдера перевірити нема як, а мок SDK не покаже, як E2B відповідає на вбиту VM. Зміни `rules/dispatcher.ts` і `skills/service.ts` (тип `skillName`) не перенесено: це звуження типу для skill-сигналу з `a5a9179daa`, якого у v4 нема. Фейковий `VmSandbox` у тесті повертає повний `CommandResult`, бо тести `sandbox` тайпчекаються. `.changeset` не переносили. |
| `a95f079204` (#28057) | опція `browser?: MastraBrowser` у `MastraFactory`, передається в `prepareAgentControllerMount` | `server/src/factory.ts` | хост: `FACTORY_BROWSER=agent-browser` у `apps/server` ставить `AgentBrowser` (`@mastra/agent-browser` 0.5.4, вже був у графі через `@mastra/code-sdk`, peer `@mastra/core` >=1.22 <2) з `headless: true, scope: 'thread'`; без змінної браузера нема, інше значення зупиняє старт. Браузер працює на хості сервера, не в пісочниці. Lockfile перерахував peer-варіанти кількох пакетів (версії ті самі). |
| `ca08ed414a` (#28292) | git-ідентичність (`user.name`/`user.email`) у репозиторії сесії до setup-команд; `gitIdentity` у GitHub-інтеграціях | `sandbox/src/github/sandbox.ts`, `integration-github/src/{integration,platform/integration}.ts`, `harness-mastra/src/workspace.ts` | блок тесту «provider authorship» з `sandbox.git.test.ts` винесено в `integration-github/src/git-identity.git.test.ts`: `sandbox` не може імпортувати GitHub-інтеграції. `gitIdentity` для platform-адаптера перенесено, бо адаптер у v4 є. |
| `c3a2784881` (#28152), `5a9e9f0bba` (#28242) | гілки GitHub-карток із суфіксом id картки (`factory/issue-13-<suffix>`), `legacyGithubWorkItemBranch` для старих сесій, `SessionBranchHeldError`, refresh-підказка review на поточній гілці сесії | `pipelines/src/{shared/work-item-branch,review/phase-rules,index}.ts`, `store/src/source-control/base.ts`, `session/src/factory-session.ts`, `api/src/surface.ts` | два кейси з `source-control/base.test.ts`, що стартують сесію через `ensureFactorySourceSession`, винесено в `session/src/factory-session.branches.test.ts` з копіями фікстур: `store` не імпортує `session`. `session` отримав залежність `@factory/pipelines`. З #28242 взято лише виправлення `default-handlers.test.ts` (решта — core/e2e Mastra) і злито в цей коміт, щоб тест не падав між комітами. У `review/board.test.ts` `decision.arguments ?? ''`, бо тести `pipelines` тайпчекаються. |
| `f7d8e6bb96` (#28330) | review/re-review оновлюють свій попередній вердикт і `## Factory test report` замість нових; редагування request-changes вердикту будить автора; парсер вердикту пропускає `> Opened by @…` | `harness-mastra/factory-skills/factory-{review,rereview}/SKILL.md`, `integration-github/src/{rules,platform/event-worker}.ts`, `session/src/review-verdict.ts`, `core/src/rules/types.ts` | `review-verdict.test.ts` — новий файл у `session/src` (в v3 його не було, тож без пари). Зміну platform event-worker перенесено, бо адаптер у v4 є. |
| `90a2126a3e` (#28487) | triage ставить мітку `severity:<level>` (одна на issue, створює мітку, якщо нема); без емодзі в severity | `harness-mastra/factory-skills/factory-triage/SKILL.md`, `harness-mastra/src/workspace.test.ts` | без відхилень. |
| `4ea5bca058` (#28497) | правило в скілах review, re-review, self-review, GitLab review, triage, plan: вміст одного репозиторію не потрапляє в коміти, PR чи коментарі іншого | `harness-mastra/factory-skills/*/SKILL.md` | у `factory-plan` і `factory-triage` речення дописано до нашого «GitHub or GitLab» (в upstream «GitHub or Linear»). |

## Далі

Порядок і обсяг — у `README.md`, розділ «Що далі».
