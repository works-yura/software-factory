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

## Прибрано: особисті моделі й пам'ять

Фабрика належить організації (рішення власника). Кожна інтерактивна сесія, запуск картки й хід Supervisor беруть ключі організації, модель за замовчуванням Фабрики й її налаштування пам'яті. Вибору області нема.

- `modelScope` (`factory | user | hybrid`) прибрано з `FactoryProject`, контрактів створення й PATCH проєкту, `effectiveModelScope` видалено. Колонку `model_scope` не читають і не пишуть.
- Політика ключів (`credential-policy`) завжди дає область організації, зокрема для чатів поза Фабрикою. Middleware підготовки ключів готує лише її. Каталоги моделей і список провайдерів показують лише ключі організації. Новим відповідям `credentialOwnerId` не ставиться.
- Ключі провайдерів і OAuth-входи: лише рядки організації й лише для адміністраторів організації. Параметр `scope` ігнорується.
- Особиста модель за замовчуванням: маршрути `/web/config/default-model` (GET, PUT, DELETE, `apply`) видалено. Домен `model-defaults` більше не реєструється й не передається інтеграціям. Модель сесії — `defaultModelId` Фабрики, без нього — модель режиму сервера.
- Особиста пам'ять: маршрути `/web/config/om*` вимагають `factoryId` (інакше 400 `factory_id_required`) і пишуть лише рядок Фабрики. `layerPersonalMemorySettings` прибрано. Сесія поза Фабрикою працює на типових порогах, назви тредів беруть рядок Фабрики сесії.
- Базу не чіпали. Таблиці `user_default_models`, особисті рядки `model_credentials` і `memory_settings` лишаються як були, їх просто не читають.
- Без змін лишились `TenantCredentialStore` з двома областями SDK (Фабрика ніколи не просить `user`), поля `userCredential` і `stored-user` у `ProviderInfo` (тепер завжди порожні) та показ старих підписів «Ваш …» на давніх відповідях.

Тести (дельти в `test-pairs.tsv`): `projects/model-scope.test.ts` видалено (тестував `effectiveModelScope`), `projects/base` −1, `credential-policy` −6, `default-model-hydration` −3, `factory-session` −3, `memory-settings-hydration` −2, `session-tools` −2, `start-coordinator` −1, `config` −6, `session-model-catalog` −1. UI: прибрано «Ваші моделі», «Ваша пам'ять», вибір області (налаштування, онбординг), футер області в пікері, особисту модель за замовчуванням; вхід у провайдера веде в моделі Фабрики. Видалено тести `use-default-model`, `DefaultModelSection`, `FactoryModelScopeNotice`, `FactoryModelScopeSection`; `ModelPicker` −7, `EmptyFactoryState` −6, `ProviderAccessSection` −3, `SettingsScopesPage`, `FactoryDefaultModelSection`, `OnboardingPreview`, `ProviderConnectionMethods`, `ProviderConnectionRecovery` по −1.
Решту кейсів переписано на одну область.

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
| `7e428dc80e` (#28052) | інструмент `factory_recreate_sandbox`, `SessionRetirementCoordinator.resetSessionSandbox()`, `clearFailedSetupCommands` | `sandbox/src/{session-retirement,session-sandbox}.ts`, `harness-mastra/src/tools/{sandbox-tools,permissions}.ts`, `server/src/factory.ts` | інструмент лише на `platform`, як в upstream. Local не вмикаємо: `LocalSandbox.destroy()` лишає робочу теку, тож після скидання лишаються checkout, незакомічені файли й маркер setup (це фіксує тест «on a LocalFactorySandbox»). E2B не вмикаємо: справжнього провайдера перевірити нема як, а мок SDK не покаже, як E2B відповідає на вбиту VM. Зміни `rules/dispatcher.ts` і `skills/service.ts` (тип `skillName`) тут не перенесено: це звуження типу для skill-сигналу з `a5a9179daa`; воно увійшло в коміт порту `a5a9179daa`. Фейковий `VmSandbox` у тесті повертає повний `CommandResult`, бо тести `sandbox` тайпчекаються. `.changeset` не переносили. |
| `a95f079204` (#28057) | опція `browser?: MastraBrowser` у `MastraFactory`, передається в `prepareAgentControllerMount` | `server/src/factory.ts` | хост: `FACTORY_BROWSER=agent-browser` у `apps/server` ставить `AgentBrowser` (`@mastra/agent-browser` 0.5.4, вже був у графі через `@mastra/code-sdk`, peer `@mastra/core` >=1.22 <2) з `headless: true, scope: 'thread'`; без змінної браузера нема, інше значення зупиняє старт. Браузер працює на хості сервера, не в пісочниці. Lockfile перерахував peer-варіанти кількох пакетів (версії ті самі). |
| `ca08ed414a` (#28292) | git-ідентичність (`user.name`/`user.email`) у репозиторії сесії до setup-команд; `gitIdentity` у GitHub-інтеграціях | `sandbox/src/github/sandbox.ts`, `integration-github/src/{integration,platform/integration}.ts`, `harness-mastra/src/workspace.ts` | блок тесту «provider authorship» з `sandbox.git.test.ts` винесено в `integration-github/src/git-identity.git.test.ts`: `sandbox` не може імпортувати GitHub-інтеграції. `gitIdentity` для platform-адаптера перенесено, бо адаптер у v4 є. |
| `c3a2784881` (#28152), `5a9e9f0bba` (#28242) | гілки GitHub-карток із суфіксом id картки (`factory/issue-13-<suffix>`), `legacyGithubWorkItemBranch` для старих сесій, `SessionBranchHeldError`, refresh-підказка review на поточній гілці сесії | `pipelines/src/{shared/work-item-branch,review/phase-rules,index}.ts`, `store/src/source-control/base.ts`, `session/src/factory-session.ts`, `api/src/surface.ts` | два кейси з `source-control/base.test.ts`, що стартують сесію через `ensureFactorySourceSession`, винесено в `session/src/factory-session.branches.test.ts` з копіями фікстур: `store` не імпортує `session`. `session` отримав залежність `@factory/pipelines`. З #28242 взято лише виправлення `default-handlers.test.ts` (решта — core/e2e Mastra) і злито в цей коміт, щоб тест не падав між комітами. У `review/board.test.ts` `decision.arguments ?? ''`, бо тести `pipelines` тайпчекаються. |
| `f7d8e6bb96` (#28330) | review/re-review оновлюють свій попередній вердикт і `## Factory test report` замість нових; редагування request-changes вердикту будить автора; парсер вердикту пропускає `> Opened by @…` | `harness-mastra/factory-skills/factory-{review,rereview}/SKILL.md`, `integration-github/src/{rules,platform/event-worker}.ts`, `session/src/review-verdict.ts`, `core/src/rules/types.ts` | `review-verdict.test.ts` — новий файл у `session/src` (в v3 його не було, тож без пари). Зміну platform event-worker перенесено, бо адаптер у v4 є. |
| `90a2126a3e` (#28487) | triage ставить мітку `severity:<level>` (одна на issue, створює мітку, якщо нема); без емодзі в severity | `harness-mastra/factory-skills/factory-triage/SKILL.md`, `harness-mastra/src/workspace.test.ts` | без відхилень. |
| `4ea5bca058` (#28497) | правило в скілах review, re-review, self-review, GitLab review, triage, plan: вміст одного репозиторію не потрапляє в коміти, PR чи коментарі іншого | `harness-mastra/factory-skills/*/SKILL.md` | у `factory-plan` і `factory-triage` речення дописано до нашого «GitHub or GitLab» (в upstream «GitHub or Linear»). |
| `85fbbbebdf` (#28512) | коментар triage читається згори вниз: рядок оцінок із точковими шкалами, підсумок, наступний крок, згорнуті розділи; поки triage триває — «Triage in progress» | `harness-mastra/factory-skills/factory-triage/SKILL.md`, `harness-mastra/src/workspace.test.ts` | без відхилень; від upstream SKILL.md відрізняється лише словником GitLab замість Linear. |
| `22084b780f` (#28100) | налаштування згруповано за темами: Акаунт (Мій акаунт, Налаштування, Підключення), Агент (Моделі, Пам’ять, Скіли, Поведінка), Factory (Репозиторії, Середовище, Надходження задач, Керування Factory); одна сторінка «Моделі» з мапою маршрутизації (чати й запуски карток → картка «Типові налаштування Factory»: модель, список провайдерів, шухляда «Додати провайдера»), рівень міркування, власні провайдери; «Пам’ять» — картка пам’яті Factory зі стрічкою рядків від повідомлень до рефлектора; `/login`, `/connect`, порожні стани нового чату й кнопка «Увійти» ведуть на `settings/models#factory-defaults`; старі `personal-models`, `models#model-packs` і `factory-memory` перенаправляють | `apps/ui/src/ui/domains/settings/{settingsSections.ts,components/models/**,components/{MemorySettings,OMSection,SettingsNavigation,SettingsPanel,SettingsSubsection,SettingsScope}.tsx,components/provider-credential.ts}`, `pages/{SettingsPage,NewPage}.tsx`, `chat/{components/ProviderLoginAction.tsx,context/useChatCommandRegistry.ts}`, `search/components/GlobalSearchNavigationResults.tsx`, `auth/components/SidebarUserMenu.tsx`, каталоги `settings`, `chat`, `search` | одна область моделей: без перемикача Personal/Hybrid/Factory, без картки «Особисті типові налаштування» й особистої пам’яті, тож `ModelRoutingSwitch`, `PersonalDefaultModel*`, `chatDefaultModel.ts`, `sessionDefaultsAnchor` не перенесено; `MODEL_ROUTES` — константа (обидві смуги → Factory), `DefaultsCard` завжди відкрита (без згортання й «Не використовується»). Джерела смуг: лише Web app, GitHub, GitLab (без Slack, Linear, Jira, incident.io). `NewPage` лишає перевірку `source === 'none'` замість `isConnectedAt(…, 'org')`: без auth ключі зберігаються без області, і upstream-перевірка заблокувала б чат. `AddApiKeyDialog` без `fixedScope` (у v4 область і так лише організації). Хеш прокручує `ScrollRestoration`, ефект у `SettingsPanel` прибрано, як в upstream. Тести: нові `FactoryThinkingControl`, `MemorySettings`, `models/**` (`FactoryDefaultModel`, `ProviderList`, `ProviderListScopes` без особистого списку, `ModelRoutingSection` переписано під одну область) — без пар; видалено `FactoryModelsSettings`, `FactoryDefaultModelSection`, `ProviderAccessSection` (рядки з `test-pairs.tsv` прибрано); `SettingsSubsection` −6, `SettingsNavigation` +1, `OMSection` +1, `GlobalSearch` +1; `SettingsScopesPage` переписано без зміни кількості. `.changeset` не переносили. |
| `74761d4c2e` (#28245) | бокова панель сесій типово показує всі сесії всіх власників одним списком без груп (`DEFAULT_SESSION_GROUP_BY = 'none'`, без типового фільтра «Мої»); порожній стан «Ваших сесій нема» прибрано | `apps/ui/src/ui/domains/workspaces/{components/SessionsSection.tsx,hooks/useSessionFilters.ts,services/{sessionFilters,sessionGroups}.ts}`, каталог `nav` | рядки сесій у v4 — кнопки, не посилання (#28105 не перенесено), тож у тестах `getByRole('button')` замість `'link'`. Тести: `SessionsSectionOwner` −2, `SessionsSectionProperties` −1, `sessionFilters` −2. |
| `c583bc9549` (#28271) | кнопка «Нова сесія» у шапці бокової панелі (відкриває порожню чернетку, як «+» біля «Сесії»); кнопку пошуку й перемикач панелі зі шапки відкритої панелі прибрано: пошук — Cmd/Ctrl+K, згортання — ручка або `[`; `newUserSessionPath()` | `apps/ui/src/ui/{AppSidebar.tsx,pages/ThreadPage.tsx}`, `domains/workspaces/{components/{SidebarNewSessionButton,SessionsSection}.tsx,services/factoryPaths.ts}`, `domains/search/components/SidebarGlobalSearchButton.tsx` (видалено), каталог `nav` (`newSession`; `searchAndNavigate` прибрано) | без відхилень. Тести: `AppLayout` +1, `GlobalSearch` відкриває пошук клавішами (кількість та сама). |
| `f39f5d64d2` (#28300) | «+» біля «Сесії» закриває мобільну шухляду навігації, як і «Нова сесія» (`useOpenNewUserSession`); кнопку пошуку прибрано з шапки сторінки при згорнутій панелі (чат і налаштування), пошук — Cmd/Ctrl+K | `apps/ui/src/ui/domains/{chat/components/{ChatPageLayout,useSidebarHeaderSlots}.tsx,workspaces/{hooks/useOpenNewUserSession.ts,components/{SessionsSection,SidebarNewSessionButton}.tsx}}`, `pages/SettingsPage.tsx` | без «edge-to-edge»: проп `edgeToEdge` у `AppShell`/`MainCard` з'явився в `@mastra/playground-ui` пізніше за 65.0.0, тож згорнута панель лишає рамку навколо сторінки; `AppLayout.tsx` і тест «gives the page the whole window» не перенесено. Тести: `AppLayout` +1 (разом +2 з #28271). `.changeset` не переносили. |
| `9173231506` (#28312) | перемикач Factory у верхньому куті бокової панелі (замість логотипа й значка Beta), поруч — кнопка пошуку й перемикач панелі; «Нова сесія» — один рядок навігації над розділами; «+» біля «Сесії» прибрано; кнопка пошуку в шапці сторінки при згорнутій панелі повертається (чат і налаштування) | `apps/ui/src/ui/{AppSidebar.tsx,pages/SettingsPage.tsx}`, `domains/{chat/components/{ChatPageLayout,useSidebarHeaderSlots}.tsx,search/components/SidebarGlobalSearchButton.tsx,workspaces/components/{FactorySwitcher,SessionsSection,SidebarNewSessionButton}.tsx}`, каталоги `nav` (`searchAndNavigate` повернуто; `sessions.new`, `factorySwitcher` прибрано), `common` (`beta` прибрано) | `SidebarActivityLink` у футері лишається (Activity у v4 не прибрано, #28257 не переносили). У `UserSessionsCreate` рядки сесій — кнопки, тож перевірку «рядка New session» звужено до регіону «Sessions», щоб не зачепити кнопку «Нова сесія». Тести: `GlobalSearch` +1 (разом +2 з #28100). |
| `7573972d0c` (#28274) | панель «Зміни» показує дифи всіх змінених файлів одним прокручуванням (як PR): липкий заголовок файлу зі статусом-іконкою й лічильниками, згортання, «Перейти до файлу» (дерево в поповері), вибір області «Зміни гілки» / «Незакомічені зміни», «…» → «Вигляд дифу» (суцільний / поруч, у `localStorage`) і «Оновити»; файл без дифу пояснює чому (завеликий, забагато змін, недоступний); `GET /web/workspace/changes/patches?workspacePath&scope=branch\|uncommitted` замість `/changes/diff` | `packages/api/src/fs.ts`, `apps/ui/src/{api/{keys,types}.ts,hooks/use-fs.ts}`, `apps/ui/src/ui/domains/workspace-viewer/{components/{WorkspaceChangesPanel,WorkspaceOverview,WorkspaceViewerPanel}.tsx,components/changes/**,hooks/useDiffLayout.ts}`, `apps/ui/src/ui/ui/{CodeDiff/**,DiffStat.tsx}`, каталог `workspaces`, `apps/ui/package.json` (`@pierre/diffs` 1.5.1) | зміни `packages/playground-ui` (`CodeDiff` з `header`/`overflow`/`ref`, `CodeDiffList`, `DiffStat`) новіші за опублікований `@mastra/playground-ui` 65.0.0, тож скопійовані в `apps/ui/src/ui/ui/` (з `code-diff.css` з dist 65.0.0, тексти через `t()`); застосунок отримав пряму залежність `@pierre/diffs` 1.5.1 (та сама версія, що в playground-ui). Тести playground-ui (`code-diff.test.tsx`, stories) не перенесено. Тести: `fs` −5, `WorkspaceViewerPanel` +4, `WorkspaceRepositoryGroups` +1. `.changeset` не переносили. |
| `a5a9179daa` (#27150) | Factory стартує скіл-ран типізованим сигналом `skill` (`type: 'reactive', tagName: 'skill', attributes: { name }`) замість user-повідомлення з `<skill>`-конвертом; `resolve*Invocation` повертають `contents` без конверта, `formatSkillMessage` загортає його для `POST /web/skills` (людський запуск лишається user-повідомленням); вміст сигналу доходить до моделі як є, екранується лише власний закривальний тег; у чаті типізований сигнал показується рядком «Skill: …» з аргументами й фідом | `harness/src/contract.ts` (`AgentSignalInput`), `runtime/src/{dispatcher,skills/service}.ts`, `api/src/skills.ts`, `patches/@mastra__core@1.79.0.patch`, `harness-mastra/src/skill-signal.test.ts`, `apps/ui/src/ui/domains/chat/{components/{TranscriptSignals,MessageBubble}.tsx,services/skill-body.ts}` | контракт `AgentSession.sendSignal` розширено до `AgentSignalInput` (user-хід або скіл-кікоф); форма скіл-сигналу та сама, що в Mastra, тож Mastra-сесія приймає її без обгортки, інший харнес має сам показати його як скіл. Зміна `packages/core/src/agent/signals.ts` (не екранувати `&`, `<`, `>` у вмісті сигналу) — pnpm-патч `@mastra/core@1.79.0` (`signalToXmlMarkup` у `dist/signals-*.{js,cjs}`); lockfile перерахував peer-хеші пакетів, що залежать від core. Тести core на це (`signal contents`, 4) і перевірка тексту для моделі з `dispatcher.test.ts` (`createSignal(kickoff).toLLMMessage()`) — у новому `harness-mastra/src/skill-signal.test.ts`, бо `runtime` не залежить від `@mastra/core`; у `dispatcher.test.ts` лишилась перевірка вмісту, що його шле диспетчер. `parseSkillBody` з `@mastra/playground-ui` (у 65.0.0 нема) — локально в `apps/ui/.../services/skill-body.ts` з тестом `services/__tests__/skill-body.test.ts`. Кейс `resolveSkillInvocation` з `expect(resolved.contents)` не перенесено: в v4 цей кейс у `harness-mastra/src/harness.test.ts` і перевіряє `activation`. Звуження `skillName?: undefined` з `7e428dc80e` — тут. Харнес Claude Code (`harness-claude-code/src/session.ts`) приймає `AgentSignalInput` і передає скіл-кікоф у CLI текстом у конверті `<skill name="…">` (вміст як є, екранується лише `</skill>`), як раніше приходив user-сигнал; тест у `session.test.ts`. Дошка Bug: її скіли (`bug-triage`, `bug-plan`, `bug-test`, `bug-build`) стартують тим самим сигналом; `server/src/rules/bug-board-runtime.test.ts` перевіряє назву скіла в атрибуті. Документацію й `.changeset` не переносили. |
| `8fb8a82428` (#28061) | модель і рівень міркування спільної сесії змінює лише її власник: guard відповідає 403 «Only the session’s owner can change its model» на `POST …/sessions/:id/model` і `PUT …/state` з `thinkingLevel` від колеги; guard читає multipart-тіло так само, як сервер (поля JSON), тож форма не обходить перевірок; `GET /web/user-sessions/:id` віддає `capabilities.switchModel`; у UI колега бачить вимкнені модель і міркування з причиною в підказці, `/model` і `/think` лише показують причину | `session/src/session-access.ts`, `api/src/source-control-sessions.ts`, `apps/ui/src/ui/domains/chat/{components/StatusLine/{ModelPicker,ModelThinkingGroup,LockedModelButton,SessionThinkingControl}.tsx,context/{ChatSessionContext.ts,ChatSessionProvider.tsx,useChatCommandRegistry.ts}}`, `apps/ui/src/ui/domains/workspaces/services/user-sessions.ts` | перенесено, хоч у v4 нема особистих ключів: власник однаково вирішує, на якій моделі йдуть його ходи, а виправлення multipart у guard — безпекове. У v4 нема передачі власності (`takeOwnership`), тож `capabilities` = `{ recreateSandbox, switchModel }`; асерти з тесту takeover у `source-control-sessions.test.ts` не перенесено, `switchModel` перевіряє `it.each` про capabilities. `value` у `ThinkingLevelUnavailable` з `@mastra/playground-ui` (у 65.0.0 нема) — локальний `ThinkingLevelLocked` у `SessionThinkingControl.tsx`. Рядки через `t()` (`chat.modelPicker.locked*`, `chat.thinking.lockedLabel`, en+uk); без імені власника — «the session owner». У `ThreadPageTeammateSession.msw.test.tsx` каталог моделей Factory (без `scope=user`) і `GET /web/factory/projects/fp-1`, бо у v4 каталог сесії — каталог Factory. `.changeset` не переносили. |

## Нові дошки

Дошки, яких нема ні у v3, ні в upstream.

| Дошка | Де | Що |
| --- | --- | --- |
| `bug` | `pipelines/src/bug`, скіли `bug-triage`, `bug-plan`, `bug-test`, `bug-build`; `harness-mastra/src/rules/reproduction-test.ts` | баги окремо від Work: intake → triage (чи це баг, severity; не баг — у `canceled` з причиною й назвою потрібної дошки) → planning (як відтворити тестом і як виправити; затвердження плану як у Work, тепер воно відкриває `tests`) → tests (окрема роль `tester`: лише падаючий тест, коміт, `factory_record_reproduction_test` пише `bugReproTestSha` і `bugReproTestPaths`; не відтворився — у `intake` для людини) → execute (роль `work`: фікс без змін тестових файлів) → review (self-review як у Work) → PR → `done` після merge. Потрапляє з issue за міткою (Settings › Intake, `bug` → `bug`). Поведінку Work, прив'язану до id `work`, узагальнено до оголошень дошки: `changeRequests` (PR відкрито → `review` + картка Review, merge → `done`, фідбек будить білдера, self-review, `selfReviewEnabled`), `triageClassification` (triage звітує `triageType`) і нове `reproductionTest: { record, protect }`. Перевірка тесту — у `factory_transition_work_item` (harness-mastra, бо політика дошки чиста й без пісочниці): вихід з `execute` у робочу фазу відхиляється, якщо `git diff --name-only --no-renames <sha>` у чекауті сесії зачіпає записані шляхи; без чекауту — відмова. |

## Далі

Порядок і обсяг — у `README.md`, розділ «Що далі».
