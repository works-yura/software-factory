# Google Cloud: логи, креші й база

Агенти читають, що повідомив працюючий продукт: логи сервера, креші застосунку й Firestore проєкту. Лише читання. Рішення: [ADR-0017](../../adr/0017-observability-firebase.md) (порт, Firebase), [ADR-0019](../../adr/0019-observability-accounts-and-bindings.md) (акаунти й прив'язки), [ADR-0027](../../adr/0027-integrations-services-and-mcp.md) («База» через MCP Toolbox), [ADR-0031](../../adr/0031-connections-one-list.md) (сторінка «Підключення»).

## Що бачить людина

**Налаштування › Підключення.** Кожна прив'язка цієї Factory — рядок «проєкт · Google Cloud» з акаунтом, можливостями («Логи», «Креші», «База») і станом (зі стану сервера «Бази», інакше «Налаштовано»; «Нічого не читає», якщо все вимкнено). Рядок відкриває сторінку прив'язки (`?connection=google-cloud:<id>`): прив'язка, її акаунт, «База (Firestore)» — що можуть її інструменти й маскування — і згорнута «Діагностика» (як це працює під капотом: MCP Toolbox, версія, сервер, останній стан). Ніде більше транспорт не названо. Сервер, який людина раніше сама створила з MCP Toolbox, теж показується рядком Google Cloud («Firestore» чи проєкт, можливість «База»). «Додати підключення» › Google Cloud — крок у тому ж вікні: акаунт організації або новий ключ (ADR-0031, доповнення). Меню: «Відв'язати від Factory» — видалити прив'язку, акаунт лишається; «Перейменувати акаунт»; «Видалити акаунт з організації» (разом з його прив'язками, з підтвердженням). «Google Cloud» у «Додати підключення» (`?connection=google-cloud`, `GoogleCloudService.tsx` з `factoryId`) — акаунти організації й прив'язки цієї Factory; акаунт з «Уже є в організації» відкриває нову прив'язку через нього. Змінює лише адмін. Стара адреса `/settings/observability` веде сюди.

- **Акаунти Google Cloud** — «Додати акаунт» (назва й JSON-ключ у діалозі). Рядок: назва · email · скільки прив'язок. Розгорнутий: перейменувати, «Замінити ключ», «Відключити», де використовується. Відключення акаунта, через який читають прив'язки, спершу питає й показує, які прив'язки підуть разом із ним.
- **Прив'язки** — «Додати прив'язку». Рядок: «syncts → syncta-57c6a · Syncta · логи». Розгорнутий: Factory, акаунт, ID і номер проєкту Google Cloud («Проєкт» — список проєктів, які бачить акаунт, або власне значення; порожній заповнюється проєктом ключа), «Логи сервера», «Креші застосунків» і застосунки, **«База (Firestore)»** і база (список баз проєкту, порожня — `(default)`; не може переглянути — підказка з роллю), «Зберегти», «Перевірити доступ» (по одному читанню на функцію, застосунок і базу; називає роль чи API, яких бракує — для бази `roles/datastore.viewer`), «Видалити прив'язку».

У сесії Factory з хоча б однією прив'язкою з логами чи крешами агент має інструменти observability (без підтвердження); без них — інструментів немає, і скіли кажуть про це у звіті.

**«База»** — це MCP Toolbox (`--prebuilt firestore`) для проєкту прив'язки, запущений під капотом як MCP-сервер, яким керує інтеграція: `FirebaseIntegration.managedMcpServers` (`managed-mcp.ts`) дає по серверу на прив'язку з «Базою» (назва `db-<проєкт>`, акаунт прив'язки за посиланням, доступ — її Factory); Factory синхронізує їх у сховище MCP-серверів з `owner {integration: 'firebase', key: <id прив'язки>}` після кожної зміни прив'язок чи акаунтів і раз на організацію за запуск. На сторінці прив'язки змінюються лише політика його інструментів і маскування; окремим MCP-сервером він ніде не показується. Список дозволених колекцій не підтримано (Toolbox prebuilt його не має) — обмеження дає роль акаунта.

## Шари

| Шар | Файл | Що робить |
| --- | --- | --- |
| Порт | `packages/capabilities/src/observability.ts` | `ObservabilityProvider.sourcesFor({orgId, factoryProjectId})` → джерело на кожну прив'язку; у джерела `target { ref, name }`, `features`, `apps`; типи результатів, `OBSERVABILITY_LIMITS`, помилки |
| Контракт | `packages/capabilities/src/observability-contract.ts` | `describeObservabilitySourceContract`: ціль, ліміти, сортування, вікно, маскування, непідтримувані функції |
| Інструменти | `packages/integrations/src/observability-tools.ts`, `log-groups.ts` | `createObservabilityTools`: чотири інструменти над усіма джерелами Factory; `pickObservabilitySource` за `project`; позначка «недовірені дані»; відмови провайдера з роллю |
| Адаптер | `packages/integration-firebase/src/*` | `settings.ts` (акаунти, прив'язки, перехід зі старої форми), `service-account.ts` (`google-auth-library`), `logging.ts`, `crashlytics.ts`, `redact.ts`, `routes.ts`, `FirebaseIntegration` |
| Підключення | `apps/server/src/mastra/index.ts` | `new FirebaseIntegration()` у списку інтеграцій; змінних середовища немає |
| Дозволи | `packages/harness-mastra/src/tools/permissions.ts` | чотири інструменти в `FACTORY_TOOLS_WITHOUT_APPROVAL`; у Claude Code сервер `factory` довірений |

## Інструменти агента

| Інструмент | Вхід | Типово |
| --- | --- | --- |
| `observability_query_logs` | `project`, `from`, `to` (ISO), `severityAtLeast`, `service`, `text`, `httpStatusAtLeast`, `limit`, `pageToken` | останні 24 год, 50 записів, нові спершу |
| `observability_log_groups` | ті самі фільтри, `maxEntries` (до 5000), `top` (до 100) | гортає всі сторінки сам; повертає `read`, `complete`, `bySeverity`, `byService` і групи (сервіс + повідомлення без id і чисел: кількість, перший і останній час, зразок), а не рядки |
| `observability_crash_issues` | `project`, `appId`, `from`, `to`, `version`, `limit` | останні 7 днів, 10 проблем, за кількістю подій |
| `observability_crash_issue` | `project`, `issueId`, `appId` (коли застосунків кілька), `from`, `to`, `eventsLimit` | 3 події: винний кадр і стек, хлібні крихти, custom keys |

`project` — ID проєкту Google Cloud або `ref` прив'язки; необов'язковий, коли проєкт з цією функцією один, обов'язковий, коли їх кілька (відмова перелічує варіанти). Опис інструмента перелічує проєкти й застосунки; кожен результат має поле `project`.

Ліміти: до 100 записів логів (у групуванні — до 5000 за виклик, 100 груп), 50 проблем, 10 подій, 15 кадрів, 20 рядків логу події, 2000 символів повідомлення, вікно до 31 дня (Crashlytics — до 90 днів назад).

## Дані й безпека

- **Ключі:** один рядок підключення інтеграції `firebase` на організацію (шифрується `FactorySecretEncryption`): `data = { accounts: { <id>: { serviceAccount } } }`, `metadata = { accounts: { <id>: { name, clientEmail, projectId, keyId } } }`. `token_uri` ключа мусить бути `https://oauth2.googleapis.com/token`, `universe_domain` — `googleapis.com`.
- **Прив'язки:** налаштування інтеграції організації, `{ version: 2, bindings: [{ id, factoryProjectId, accountId, projectId, projectNumber?, logs, crashes, apps[], database?: { enabled, databaseId? } }] }`; без `database` — вимкнено (прив'язки до «Бази» лишаються як були).
- **Перехід зі старої форми** (`{ serviceAccount }` і `{ factories }`): при першому читанні організації, ідемпотентно; ключ стає акаунтом, мапінги — прив'язками (`bnd-<factoryId>`).
- **Токени:** `google-auth-library` `JWT` на кожен scope (`logging.read`, `firebase`, `datastore` — лише для перевірки «Бази»), кеш токенів на ключ.
- **Маскування** (`redact.ts`) — до виходу з адаптера: email, телефони, IPv4/IPv6, Bearer/JWT, ключі Google/Stripe/GitHub/Slack, пари `password=`/`token=`, блоки приватних ключів. З URL запитів лишається тільки шлях. `user` у подіях Crashlytics відкидається.
- **Аудит:** `factory.observability.connected` (акаунт додано, ключ замінено, перейменовано), `disconnected` (акаунт відключено, з переліком знятих прив'язок), `mapping_updated` (прив'язку збережено чи видалено) — без ключа.

## Маршрути (`/web/firebase`)

`GET status` (акаунти з `bindingIds` і прив'язки) · `POST accounts` · `PUT accounts/:id` (назва та/або новий ключ) · `DELETE accounts/:id[?withBindings=true]` (409 `account_in_use`, якщо прив'язки є, а прапорця немає) · `POST bindings` · `PUT bindings/:id` · `DELETE bindings/:id` · `POST bindings/check` · `GET accounts/:id/projects` · `GET accounts/:id/databases?project=`. Кожен запис відповідає повним станом.

**Що бачить акаунт** (`packages/integration-firebase/src/discovery.ts`; той самий пошук дає `CredentialProvider.discover` формі MCP-сервера). Лише читання, ключем самого акаунта; ключ і токени назад не йдуть. Відмова не ламає форму: лишаються проєкт ключа чи `(default)` і `denied { role, message }`.

| Що | Виклик | Область | Право | Роль |
| --- | --- | --- | --- | --- |
| Проєкти | `GET cloudresourcemanager.googleapis.com/v3/projects:search` (до 300, лише `ACTIVE`) | `cloud-platform.read-only` | повертаються лише проєкти з `resourcemanager.projects.get` | `roles/datastore.viewer` дає його на своєму проєкті |
| Бази Firestore | `GET firestore.googleapis.com/v1/projects/{p}/databases` | `datastore` | `datastore.databases.list` | `roles/datastore.viewer` |

Джерела (перевірено 2026-11-12): [projects.search](https://docs.cloud.google.com/resource-manager/reference/rest/v3/projects/search), [databases.list](https://docs.cloud.google.com/firestore/docs/reference/rest/v1/projects.databases/list), [ролі Firestore](https://docs.cloud.google.com/firestore/docs/security/iam) — Cloud Datastore Viewer містить `datastore.databases.list`, `datastore.databases.get`, `datastore.databases.getMetadata`, `resourcemanager.projects.get`, `resourcemanager.projects.list`.

## Хто використовує

- Аудит `stability` (`packages/pipelines/src/audits/profiles.ts`, чекліст `audit-run/references/stability.md`), терміновий від `high`.
- `factory-triage`: для бага шукає помилку в логах і креш перед гіпотезами.

## Як додати провайдера

Див. «Як додати провайдера» в [ADR-0017](../../adr/0017-observability-firebase.md); провайдер віддає `sourcesFor(scope)` — масив джерел із `target`. Двох провайдерів в одній Factory поки не підтримано (однакові назви інструментів).
