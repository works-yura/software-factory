# @factory/integrations

Контракт інтеграції (`FactoryIntegration`, `IntegrationContext`) і спільні частини: звірка задач, сесії підписок, клієнт Mastra Platform, маршрути platform-connect, реєстр підключень.

## Як написати й перевірити конектор (ADR-0035, ADR-0037)

UI не знає провайдерів: усе, що людина бачить і може зробити, описує сервер.

**Контракт.**
1. Реалізуйте `IntegrationConnections` (`src/connections.ts`). Обов'язкові `describe`, `list`, `connect`; решта (`reconnect`, `rename`, `removalImpact`, `remove`, `unlink`, `detail`, `updateSettings`, `getAuthStatus`, `activity`) — коли конектор це вміє. Чого не реалізовано, того не пропонуйте в `actions`.
2. `describe`: назва, ключ логотипа (`icon`), `category` (`tools` | `sources` | `agents`), `provides`, `capabilities` і `health` у формах `@mastra/core/tool-provider`, способи з `authKind: 'oauth' | 'apiKey'` і полями `ConnectionField` (плюс `secret`, `textarea`, `file`, `select`).
3. `list`: рядки з власним id (реєстр додасть `<id конектора>:`), `status`, `accountLabel`, `displayName`, `label`, станом словами і діями — `true` або `{ reason }` (причини самого конектора: «керується на Platform», «змініть змінні середовища»; ролі — ні, див. права).
4. Тексти — малий каталог `ConnectionCopy<T>` (`{ en, uk }`); мову бере `request.language`.
5. Видалення: без `confirm` і з залежними — `connectionRefused(409, { …, impact })`.
6. Налаштування — секція `settings` у `detail` і `updateSettings`; перемикачі зберігаються одразу, решта — кнопкою секції.
7. Потік поза браузером (вхід CLI на машині сервера): `authorize` без `url` — з `authId` і `waiting`; `getAuthStatus` повертає `{ status, message }`.
8. «Активність»: необов'язковий `activity(request, { since, limit })` — виклики агентів через підключення для `request.factoryProjectId`; реєстр зводить їх у `GET /web/connections/activity`.

**Права.** Конектор лише оголошує: `permissions: { connect, reconnect, rename, remove, unlink, settings }` — `'member'`, `'admin'` (типово) або `{ policy: '<назва>' }` з `policies` (`(request, localId) => true | { reason }`); `settings` може бути мапою за id секції. Реєстр перевіряє їх на кожному маршруті й сам перетворює заборонену дію, спосіб чи поле налаштувань на `{ reason }` у відповіді. `request.admin` у конекторі не перевіряють.

**Версія.** `CONNECTIONS_CONTRACT_VERSION` (`@factory/contracts`, semver): додати необов'язкове поле, тип секції чи категорію — мінорна версія; прибрати чи змінити значення — мажорна. Конектор оголошує `contractVersion`; реєстр не обслуговує іншу мажорну версію (називає в `failures`), UI з іншою мажорною показує «треба оновити».

**Тести.** У кожному конекторі — `describeConnectorContract(label, setup)` з `@factory/integrations/testing`: опис і список, дії, деталі й вплив, права для учасника, ізоляція від збою сусіда, підключення / перейменування / видалення з підтвердженням, потік `authId`, тексти en/uk, жодного секрету фікстури у відповідях. Фікстура дає реєстрацію, `orgId`, адміна й учасника, секрети й необов'язкові `seed`, `connect`, `authorize`, `rename`, `remove`. Для UI — `describeConnectorUi` (`apps/ui/.../__tests__/fixtures/connectorUiContract.tsx`): будь-який конектор крізь список, сторінку, «Додати» і видалення. Логотип — ключ у `ConnectionIcon`, інакше гліф сервера.

**Реєстрація й пакування.**
- Інтеграція повертає фасет із `FactoryIntegration.connections(ctx)`; не-інтеграція (MCP, акаунти агентів) — через `assembleFactoryApiRoutes({ connectors })`.
- Сторонній конектор — пакет, що експортує `connector: ConnectorPackage` (`{ id, contractVersion, create(context) }`); сервер імпортує його на старті з `FACTORY_CONNECTOR_PACKAGES` (через кому; специфікатор модуля або шлях до зібраного JS). Пакет, що не завантажився (імпорт, експорт, зайнятий id, інша мажорна версія, `create` упав), не зупиняє сервер — його названо в `failures`. Зразок — `examples/connector-example` (Notes Cloud); він проходить той самий набір перевірок.

Єдиний виняток із дескрипторів — редактор MCP-сервера (`custom: mcp-server`; чому — ADR-0037). Маршрути `/web/connections*` монтує `assembleFactoryApiRoutes` (`@factory/api`); власні адмін-маршрути конектору не потрібні.

## Як додати харнес з акаунтами (ADR-0036)

1. Дескриптор у `packages/contracts/src/harnesses.ts`: `icon` (ключ логотипа) і `setup.accounts: { provider, connector }`.
2. Сервер: вид входу й назва — `SIGN_IN_ACCOUNT_PROVIDERS` (`packages/api/src/credential-accounts.ts`), потік входу CLI (`createAccountSignInService`), фасет `HarnessUsage` для лімітів. `assembleFactoryApiRoutes` сам зареєструє `createAgentAccountsConnections` для харнесу, який сервер запускає.
3. Права акаунтів — `permissions` конектора агентів (`connect: 'member'`, решта — політики `owner` / `ownerOrAdmin`).
4. Фасет моделей — через `withConnectionAvailability(models, { connector, missing })`: без входу людини харнес недоступний з причиною, і UI його ніде не пропонує.
5. UI не змінюється: харнес приходить з `/web/config/features` і `/web/config/models`; логотип — ключ у `ConnectionIcon`.
