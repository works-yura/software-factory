# MCP-сервери

Зовнішні MCP-сервери, якими користуються агенти (база через MCP Toolbox, згодом логи, Sentry). Рішення: [ADR-0025](../../adr/0025-mcp-servers-manager.md).

## Що бачить людина

Налаштування › **Інтеграції › MCP** (`/factories/<factory>/settings/integrations?tab=mcp`; стара адреса `/settings/mcp-servers` веде сюди, [ADR-0027](../../adr/0027-integrations-services-and-mcp.md)), для всієї організації:

- **«Додати сервер»** відкриває каталог: картки з назвою й описом мовою людини та пошуком, останньою — «Власний сервер». Зараз у каталозі «База даних (MCP Toolbox)».
- **Форма сервера з каталогу** будується з його `server.json`:
  - «Назва» (типово — назва з каталогу);
  - «Що підключити» — спосіб запуску (для Toolbox: Firestore, PostgreSQL, власний tools.yaml);
  - поля, які оголосив цей спосіб, з людськими назвами й описами, позначкою «обов'язково», підказкою типового значення («Порожньо — localhost»), списком варіантів;
  - секретні поля (пароль, tools.yaml) вводяться раз і більше не показуються; порожнє поле при збереженні лишає збережене;
  - **«Акаунт Google Cloud»** — вибір з акаунтів сервісу Google Cloud (ім'я · email), без вставляння ключа; «+ Додати акаунт» відкриває той самий діалог, що в сервісі, і вибирає новий акаунт; немає акаунтів — підказка додати їх там;
  - **«Проєкт Google Cloud»** і **«База Firestore»** — список, у який можна й вписати своє значення: проєкти, які бачить вибраний акаунт, і бази вибраного проєкту. Порожнє поле заповнюється очевидним: проєкт з прив'язки Google Cloud Factory, якщо сервер призначено Factory з прив'язкою, інакше проєкт, з якого ключ акаунта; база — `(default)`. Якщо акаунт не може переглянути список, у списку лишається проєкт ключа чи `(default)`, а під полем — приглушена підказка, яку роль видати (`roles/datastore.viewer`).
- **«Власний сервер»:** «Як запускати» — «Локальна команда» (команда, аргументи, змінні, секретні змінні) або «Адреса» (адреса, заголовки, секретні заголовки).
- **Доступ** (налаштування 1): список Factory; для кожної — необов'язково лише деякі дошки й фази. Без дошок і фаз сервер отримують усі сесії Factory, зокрема чат; з обмеженням — лише сесії карток на цих дошках і фазах. Новий сервер, відкритий з налаштувань Factory, починає з доступом цієї Factory (його можна прибрати); інакше його не отримує ніхто.
- **Інструменти** (налаштування 2): «Перевірити» запускає сервер з тим, що введено у формі — **ще до збереження** — і показує його інструменти; нічого не зберігається, тимчасовий файл ключа видаляється. Поки обов'язкові поля порожні, кнопка неактивна, а під нею — які саме заповнити. Для кожного інструмента — «Дозволено» / «З підтвердженням» / «Заборонено», плюс типова політика сервера (за замовчуванням «Дозволено»). Інструменти, що змінюють дані (з оверлею каталогу), позначено «змінює дані» — нічого не забороняється без людини. Член організації перевіряє лише збережений сервер.
- **Маскувати персональні дані** (типово так), **Увімкнено**.
- **«Додатково» › Ідентифікатор** — утворюється з назви (латиницею), агент бачить інструменти як `<ідентифікатор>_<інструмент>`; можна змінити.
- Член організації бачить сервери лише для читання; змінює адмін організації.

## Як це працює

- **Каталог:** `packages/server/src/mcp-servers/catalog/<id>.server.json` — офіційний формат MCP Registry ([схема](https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json)): `packages[]` (npm, `identifier`, `version`, `transport: stdio`, `packageArguments`, `environmentVariables` з `isRequired`, `isSecret`, `default`, `choices`, `format: filepath`). Поруч `<id>.factory.json` — оверлей Factory: `label`/`summary` (uk/en), `entrypoint` пакета, `variants` (аргументи `${вхід}`, які входи показати, які обов'язкові, інструменти, що пишуть) і `inputs` (назви, описи, `credential: google-cloud-account`, `suggest: { from, dependsOn }`). `suggest.from` — звідки брати варіанти (`google-cloud-projects`, `firestore-databases`); `dependsOn` — вхід з акаунтом, далі по одному входу на параметр пошуку з `MCP_SUGGESTION_CONTEXT` (для баз — `project`). Оверлей, що залежить від невідомого входу чи не від акаунта першим, падає при старті. Розбір і побудова полів — `packages/core/src/mcp-servers/catalog.ts` (`mcpCatalogEntry`, `mcpCatalogVariant`, `mcpServerSlug`); зламаний файл падає при старті.
- **Облікові дані:** порт `CredentialProvider` (`packages/capabilities/src/credentials.ts`): `list` без секретів, `readSecret` лише для лаунчера, `suggest`, `discover(orgId, accountId, source, context)` — варіанти, знайдені цим акаунтом, лише читання; відмова не ламає форму — повертаються відомі значення й `denied { role, message }`. Інтеграція позичає свої через `credentialProviders()` (Firebase — акаунти Google Cloud, `packages/integration-firebase/src/credentials.ts`); сервер збирає їх у `McpCredentials` (`packages/server/src/mcp-servers/credentials.ts`). У конфігу сервера — лише посилання `{kind, id}`.
- **Сховище:** `McpServersStorage` (`packages/store/src/mcp-servers/base.ts`, таблиця `factory_mcp_servers`): конфіг запуску (`McpServerLaunch`: `catalog` — запис, спосіб, входи, посилання на акаунти; `stdio` — власна команда; `http` — адреса), доступ, політика, маскування, увімкнення; секрети — один зашифрований JSON. Модель — `packages/core/src/mcp-servers/model.ts`.
- **API:** `packages/server/src/mcp-servers/routes.ts` — `GET /web/mcp-servers` (сервери, каталог, акаунти для входів, `canEdit`), `GET /web/mcp-servers/suggestions?factoryProjectId=`, `POST`, `PUT/DELETE /web/mcp-servers/:id`, `POST /web/mcp-servers/:id/status`, `POST /web/mcp-servers/discover` (`{credential, from, context}` → варіанти; читання), `POST /web/mcp-servers/check` (`{id?, server}` — запуск незбереженого конфігу, секрети збереженого `id` доповнюють не введені заново; лише адмін, бо запускає процес; нічого не зберігає). Запис каталогу перевіряється: відомий запис, спосіб, лише його входи, правильний тип акаунта. Без значень секретів, `no-store`, записи — адмін, аудит.
- **Запуск:** `launch.ts` — для запису каталогу: зафіксований пакет із `node_modules` (`catalogEntrypoint`, версія мусить збігатися), значення кожного входу з акаунта / секрету / звичайного значення / типового, обов'язкові перевіряються з назвою поля, файли (ключ, tools.yaml) — у `mkdtemp` (0700, 0600), видаляються при зупинці; вхід-змінна йде в оточення, вхід-аргумент — лише в `${…}` аргументів. Оточення процесу — лише його змінні плюс `PATH`/`HOME`.
- **Хаб:** `hub.ts` (`McpServerHub`): сесія отримує призначені її картці сервери, старт із першим запитом інструментів, зупинка після 15 хв простою, `release`, вимкнення Factory; `deny` не видається, `ask` — підтвердження, маскування, аудит `factory.mcp_server.tool_called`.
- **Сесії:** `sessionExtraTools` у `packages/server/src/factory.ts`: Mastra — у процесі, Claude Code і Codex — через MCP-ендпоінт Factory.
- **Міграція:** `mcpServers.presetsToCatalog.v1` (`migrations.ts`) переносить сервери з першими пресетами (`toolbox-firestore`, `toolbox`) у записи каталогу; вставлений раніше ключ лишається секретним файлом того самого входу, поки людина не вибере акаунт.

## Як додати

- **Ще одну базу** — «База даних (MCP Toolbox)» › PostgreSQL або «Власний tools.yaml» (MySQL, MongoDB, BigQuery… — документація Toolbox).
- **Новий запис каталогу** — пакет у залежностях `packages/server` з точною версією, `<id>.server.json` у форматі MCP Registry (з репозиторію сервера або `registry.modelcontextprotocol.io`) і `<id>.factory.json` з назвами uk/en; рядок у `MCP_CATALOG` (`catalog.ts`); тест у `hub.test.ts`.
- **Новий тип облікових даних** — `CredentialKind` у `@factory/capabilities`, провайдер в інтеграції, `credential` у оверлеї.

## Де в коді

- Модель і каталог: `packages/core/src/mcp-servers/{model,catalog}.ts`
- Порт облікових даних: `packages/capabilities/src/credentials.ts`
- Сховище: `packages/store/src/mcp-servers/base.ts`
- Каталог, хаб, запуск, облікові дані, міграція, область, маршрути: `packages/server/src/mcp-servers/`
- Маскування: `packages/capabilities/src/redact.ts`
- UI: `apps/ui/src/ui/domains/settings/components/McpServersSection.tsx`, `components/mcp-servers/{McpServerEditor,McpCatalogFields,McpServerAccess}.tsx`, `services/mcpServers.ts`, `hooks/useMcpServers.ts`

## Сервери, якими керують сервіси

Інтеграція може запускати MCP-сервер під капотом (Google Cloud «База» → MCP Toolbox). Вона оголошує бажаний стан (`FactoryIntegration.managedMcpServers(orgId)` → `ManagedMcpServerSpec[]`), а `ManagedMcpServers` (`packages/server/src/mcp-servers/managed.ts`) синхронізує його у сховище (`McpServersStorage.syncOwned`, колонка `owner`): створює, оновлює конфіг і доступ, прибирає зайві; політику інструментів, маскування й вмикання, які задала людина, зберігає; зайняту назву замінює на `назва-2`… Синк — після змін у сервісі (хук `onManagedMcpServersChanged`) і раз на організацію за запуск перед першим читанням (`ensure` у списку й у хабі; невдача — гучно в журнал, сесія працює зі збереженими серверами). API: `PUT` такого сервера змінює лише `toolPolicies` і `maskPersonalData`; `DELETE` — `409 managed_by_integration`. UI: «керує Google Cloud», конфіг і доступ лише для читання, без «Видалити», посилання на сервіс.
