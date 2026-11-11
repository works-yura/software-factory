# 0017. Логи й креші для агентів: можливість observability, Firebase як перший адаптер

Дата: 2026-11-11 · Статус: прийнято · Коміти: `2d130f4` (порт і адаптер), `2ace77b` (маршрути й інструменти), `fbf72c9` (UI), `952dbf8` (аудит стабільності, розбір багів)

**Контекст.** Розбір бага і аудит гадають там, де продукт уже записав відповідь: у логах сервера й крешах застосунку. Клієнтські продукти (Syncta, PostAirborne) живуть на Firebase: логи — у Cloud Logging, креші — у Crashlytics. Агентам потрібно читати їх, але лише читати, без ключів у пісочниці, без персональних даних клієнтів у моделі, і так, щоб завтра можна було підключити Sentry чи Datadog без переписування агентів.

**Рішення.**

```text
@factory/capabilities  observability.ts          порт: ObservabilityProvider → ObservabilitySource (per Factory)
                                                  queryLogs · listCrashIssues · getCrashIssue, features {logs, crashes},
                                                  ліміти OBSERVABILITY_LIMITS, помилки Unsupported / Query / Provider(missingRole, fix)
                       observability-contract.ts  набір тестів, який проходить кожен адаптер
        ▲
@factory/integrations  observability-tools.ts    інструменти агента, написані раз над портом:
                                                  observability_query_logs · observability_crash_issues · observability_crash_issue
        ▲
@factory/integration-firebase                    адаптер (FactoryIntegration):
  service-account.ts   JWT bearer grant на node:crypto; token_uri лише https://oauth2.googleapis.com/token
  logging.ts           Cloud Logging entries:list; фільтр збирається з типізованого вводу, текст екранується
  crashlytics.ts       Crashlytics REST v1alpha: звіт topIssues, events; без user id
  redact.ts            єдине місце маскування: email, телефони, IP, токени, ключі — до того, як щось вийде з пакета
  settings.ts          ключ — зашифрований рядок підключення організації; проєкт і застосунки — налаштування per Factory
  routes.ts            /web/firebase: статус, ключ (лише адмін), мапінг Factory, перевірка доступу
```

- **Лише читання на кожному рівні:** ролі `roles/logging.viewer` і `roles/firebasecrashlytics.viewer`, scope `logging.read` для логів; Crashlytics приймає лише `firebase`/`cloud-platform`, тож береться вужчий `firebase`, а межу ставить роль Viewer. Порт не має методів запису.
- **Ключ ніколи не йде агенту:** він лежить у рядку підключення інтеграції, зашифрованому ключем Factory; API, аудит і UI бачать лише `clientEmail`, `projectId`, `keyId`. Інструменти працюють на сервері; у пісочницю нічого не пишеться.
- **Обидва harness одним кодом:** інструменти — `agentTools` інтеграції, які сервер віддає і Mastra (в процесі), і Claude Code (через MCP Factory). Сесія отримує їх лише коли її Factory має мапінг і організація — ключ, і лише для наявних функцій. Без підтвердження, як інші інструменти читання.
- **Креші — через Crashlytics REST API, не через BigQuery.** Цей API (v1alpha) використовує власний MCP-сервер Firebase CLI; він не потребує вмикати експорт і платити за запити. Він альфа: зміна з боку Google проявиться гучною помилкою провайдера, не порожніми даними.
- **Помилки, з якими можна щось зробити:** відмова 403 називає роль, вимкнений API — що ввімкнути; інструмент повертає це агенту, а «Перевірити доступ» у налаштуваннях — людині.
- **Використання:** профіль аудиту `stability` («Стабільність: логи і креші») на дошці «Аудити»; `factory-triage` читає логи й креші для бага.

**Наслідки.** Новий провайдер (Sentry, Datadog, BigQuery-експорт Crashlytics) — один адаптер, що проходить `describeObservabilitySourceContract`, і його маршрути підключення; інструменти, скіли й аудит лишаються. Двох провайдерів в одній сесії поки бути не може: їхні інструменти мали б однакові назви (сервер падає на конфлікті) — потрібен агрегатор, коли до цього дійде. Альфа-API Crashlytics може змінитися.

**Альтернативи.**
- *Підключити офіційний MCP-сервер Firebase у сесію* — відкинуто: ключ або вхід CLI потрапили б у сесію, інструментів багато й не всі лише на читання, маскувати дані нема де.
- *Креші через BigQuery-експорт* — відкладено: стабільна схема, але треба вмикати експорт (синхронізація раз на добу або стрімінг), ролі BigQuery Job User і платні запити. Може стати другим адаптером.
- *Ключ у змінних середовища сервера* — відкинуто: у кожної організації свій проєкт; ключ з UI зберігається зашифрованим.

**Як додати провайдера.** 1) Пакет `integration-<провайдер>` з класом, що реалізує `ObservabilityProvider` (`sourceFor(scope)` → джерело з `features`, `apps`, трьома методами); усі рядки — через маскування, ліміти з `OBSERVABILITY_LIMITS`. 2) Тест `describeObservabilitySourceContract('<Name>', seed => …, { features })` з підробленим HTTP із `seed`. 3) `agentTools` → `createObservabilityTools({ requestContext, provider })`. 4) Маршрути підключення й секція UI. 5) Зареєструвати інтеграцію в `apps/server/src/mastra/index.ts`.

Джерела (перевірено 2026-11-11): [Cloud Logging entries.list](https://docs.cloud.google.com/logging/docs/reference/v2/rest/v2/entries/list), [Crashlytics reports.get](https://firebase.google.com/docs/reference/crashlytics/rest/v1alpha/projects.apps.reports/get), [Crashlytics events](https://firebase.google.com/docs/reference/crashlytics/rest/v1alpha/projects.apps.events/batchGet), [MCP-сервер Firebase](https://firebase.google.com/docs/cli/mcp-server), [схема BigQuery-експорту Crashlytics](https://firebase.google.com/docs/crashlytics/bigquery-dataset-schema), [ролі Crashlytics](https://docs.cloud.google.com/iam/docs/roles-permissions/firebasecrash).
