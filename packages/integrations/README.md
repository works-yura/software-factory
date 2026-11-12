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

Маршрути `/web/connections*` монтує `assembleFactoryApiRoutes` (`@factory/api`); власні адмін-маршрути конектору не потрібні.
