# Логи й креші (observability)

Агенти читають, що повідомив працюючий продукт: логи сервера й креші застосунку. Лише читання. Рішення й альтернативи — [ADR-0017](../../adr/0017-observability-firebase.md).

## Що бачить людина

- **Налаштування › Логи і креші** (`apps/ui/src/ui/domains/settings/components/ObservabilitySection.tsx`):
  - *Підключення Firebase* (для всієї організації): вставити або вибрати JSON-ключ сервісного акаунта; після збереження видно лише email акаунта і його проєкт. «Замінити ключ», «Відключити». Змінює лише адмін організації.
  - *Проєкт Firebase цієї Factory*: ID проєкту (логи), номер проєкту (Crashlytics), перемикач «Логи сервера», застосунки (Firebase App ID, платформа, назва). «Перевірити доступ» робить одне читання на кожну функцію й застосунок і пише, якої ролі бракує або який API ввімкнути.
- У сесії Factory з мапінгом агент має інструменти (без підтвердження). Без мапінгу чи ключа — інструментів немає, і скіли кажуть про це у звіті.

## Шари

| Шар | Файл | Що робить |
| --- | --- | --- |
| Порт | `packages/capabilities/src/observability.ts` | `ObservabilityProvider.sourceFor({orgId, factoryProjectId})` → `ObservabilitySource` або `null`; типи результатів, `OBSERVABILITY_LIMITS`, помилки |
| Контракт | `packages/capabilities/src/observability-contract.ts` | `describeObservabilitySourceContract`: ліміти, сортування, вікно, маскування, непідтримувані функції |
| Інструменти | `packages/integrations/src/observability-tools.ts` | `createObservabilityTools`: три інструменти над портом, область сесії з `requestContext`, позначка «недовірені дані», відмови провайдера з роллю |
| Адаптер | `packages/integration-firebase/src/*` | ключ і токени, Cloud Logging, Crashlytics, маскування, налаштування, маршрути, `FirebaseIntegration` |
| Підключення | `apps/server/src/mastra/index.ts` | `new FirebaseIntegration()` у списку інтеграцій; змінних середовища немає |
| Дозволи | `packages/harness-mastra/src/tools/permissions.ts` | три інструменти в `FACTORY_TOOLS_WITHOUT_APPROVAL`; у Claude Code сервер `factory` довірений |

## Інструменти агента

| Інструмент | Вхід | Типово |
| --- | --- | --- |
| `observability_query_logs` | `from`, `to` (ISO), `severityAtLeast`, `service`, `text`, `limit`, `pageToken` | останні 24 год, 50 записів, нові спершу |
| `observability_crash_issues` | `appId`, `from`, `to`, `version`, `limit` | останні 7 днів, 10 проблем, за кількістю подій |
| `observability_crash_issue` | `issueId`, `appId` (коли застосунків кілька), `from`, `to`, `eventsLimit` | 3 події: винний кадр і стек, хлібні крихти, custom keys |

Ліміти: до 100 записів логів, 50 проблем, 10 подій, 15 кадрів, 20 рядків логу події, 2000 символів повідомлення, вікно до 31 дня (Crashlytics — до 90 днів назад).

## Дані й безпека

- Ключ: рядок підключення інтеграції `firebase` (шифрується `FactorySecretEncryption`), метадані — `clientEmail`, `projectId`, `keyId`. `token_uri` ключа мусить бути `https://oauth2.googleapis.com/token`.
- Мапінг: налаштування інтеграції організації, `factories[<factoryProjectId>] = { projectId, projectNumber?, logs, apps[] }`.
- Маскування (`redact.ts`) — до виходу з адаптера: email, телефони, IPv4/IPv6, Bearer/JWT, ключі Google/Stripe/GitHub/Slack, пари `password=`/`token=`, блоки приватних ключів. З URL запитів лишається тільки шлях. `user` у подіях Crashlytics відкидається.
- Аудит: `factory.observability.connected | disconnected | mapping_updated` (без ключа).

## Хто використовує

- Аудит `stability` (`packages/pipelines/src/audits/profiles.ts`, чекліст `audit-run/references/stability.md`), терміновий від `high`.
- `factory-triage`: для бага шукає помилку в логах і креш перед гіпотезами.

## Як додати провайдера

Див. «Як додати провайдера» в [ADR-0017](../../adr/0017-observability-firebase.md). Двох провайдерів в одній Factory поки не підтримано (однакові назви інструментів).
