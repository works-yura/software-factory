# @factory/integrations

Контракт інтеграції (`FactoryIntegration`, `IntegrationContext`) і спільні частини: звірка задач, сесії підписок, клієнт Mastra Platform, маршрути platform-connect, реєстр підключень.

## Як додати конектор у «Підключення» (ADR-0035)

UI не знає провайдерів: усе, що людина бачить і може зробити, описує сервер.

1. Реалізуйте `IntegrationConnections` (`src/connections.ts`) у пакеті інтеграції й поверніть його з `FactoryIntegration.connections(ctx)`. Обов'язкові `describe`, `list`, `connect`; решта (`reconnect`, `rename`, `removalImpact`, `remove`, `unlink`, `detail`, `getAuthStatus`) — коли конектор це вміє. Чого не реалізовано, того не пропонуйте в `actions`.
2. `describe`: назва, ключ логотипа (`icon`), `category`, `provides` (що дає агентам), `capabilities` і `health` у формах `@mastra/core/tool-provider`, способи з `authKind: 'oauth' | 'apiKey'` і полями `ConnectionField` (плюс `secret`, `textarea`, `file`).
3. `list`: рядки з власним id (реєстр додасть `<id інтеграції>:`), `status`, `accountLabel`, `displayName`, `label`, станом словами і діями — `true` або `{ reason }`, вирішеними на сервері (права, звідки облікові дані).
4. Тексти — малий каталог `ConnectionCopy<T>` (`{ en, uk }`) у пакеті конектора; мову бере `request.language`.
5. Видалення: без `confirm` і з залежними — `connectionRefused(409, { …, impact })`; вплив перелічує залежних і що станеться з кожним елементом.
6. Тести: контрактний тест через `buildConnectionRoutes` (методи, список, дії, вплив, підключення, видалення) — зразок у `integration-github/src/token-auth.test.ts`. Логотип, якщо його немає в `ConnectionIcon` UI, — додайте мітку за ключем; інакше показується гліф сервера.

7. Налаштування підключення — секція `settings` у `detail` (поля з поточними значеннями) і `updateSettings`; перемикачі зберігаються одразу, решта — кнопкою секції. Дозволи вирішує конектор (поле, яке людині не можна змінювати, — `disabled` з причиною).
8. Конектор, що не є інтеграцією (як MCP-сервери), реєструється через `assembleFactoryApiRoutes({ connectors })`.
9. Хто може змінювати: за замовчуванням — лише адміністратор організації (реєстр відмовляє сам). Конектор, де кожен учасник керує своїм (акаунти агентів), ставить `memberManaged: true` і перевіряє права сам.
10. Потік, що завершується поза браузером (вхід CLI на машині сервера): `authorize` без `url` — з `authId` і `waiting` (`title`, `message`, `timeoutMs`); `getAuthStatus` повертає `{ status, message }`.

## Як додати харнес з акаунтами (ADR-0036)

1. Дескриптор у `packages/contracts/src/harnesses.ts`: `icon` (ключ логотипа) і `setup.accounts: { provider, connector }`.
2. Сервер: вид входу й назва — `SIGN_IN_ACCOUNT_PROVIDERS` (`packages/api/src/credential-accounts.ts`), потік входу CLI (`createAccountSignInService`), фасет `HarnessUsage` для лімітів. `assembleFactoryApiRoutes` сам зареєструє `createAgentAccountsConnections` для харнесу, який сервер запускає.
3. Фасет моделей — через `withConnectionAvailability(models, { connector, missing })`: без входу людини харнес недоступний з причиною, і UI його ніде не пропонує.
4. UI не змінюється: харнес приходить з `/web/config/features` і `/web/config/models`; логотип — ключ у `ConnectionIcon`.

Єдиний виняток із дескрипторів — редактор MCP-сервера (`custom: mcp-server` у секціях і `editor` у способі); новий конектор ним не користується.

Маршрути `/web/connections*` монтує `assembleFactoryApiRoutes` (`@factory/api`); власні адмін-маршрути конектору не потрібні.
