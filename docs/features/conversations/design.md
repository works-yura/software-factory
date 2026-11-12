# Розмови з агентом поза Factory

Людина пише агенту там, де працює (зараз — коментар задачі ClickUp), і отримує відповідь у тому ж треді. Рішення: [ADR-0018](../../adr/0018-conversation-channels.md).

## Як це працює зараз

| Крок | Що відбувається | Код |
| --- | --- | --- |
| Читання | Кожні `intervalSeconds` (типово 60 с) воркер `clickup-conversations-issue-reconcile` бере задачі з відстежуваних List (Settings › Intake), оновлені після курсора, і їхні коментарі. Коментарі, написані до старту сервера, не обробляються. Відповіді в треді читаються лише для тредів, де звернулися до Factory | `packages/integration-clickup/src/conversation.ts` |
| Звернення | Коментар звернений до Factory, якщо згадує (тег) акаунт, якому належить токен ClickUp, або це відповідь у треді, де Factory вже звертались | `createClickUpConversationPoller` |
| Свої коментарі | Коментарі акаунта токена — `fromBot`, агента не будять | `ConversationRouter.handle` |
| Прив'язка | Неприв'язаному відправнику Factory відповідає в треді зі згадкою й посиланням `<publicUrl>/connect/clickup`. На сторінці учасник бере код і відповідає в треді `connect FCT-XXXXXX` зі свого акаунта. Код одноразовий, діє 30 хв, живе в пам'яті сервера | `packages/integrations/src/conversation/{router,connect-codes,surface}.ts`, `apps/ui/src/ui/pages/ConnectAccountPage.tsx` |
| Картка й сесія | Тред належить картці задачі. Немає картки, акаунт з іншої організації або на картці немає сесії — Factory пише це в треді | `ConversationRouter` |
| Голос | Аудіовкладення (`audio/*` або m4a/mp3/ogg/opus/wav/webm/aac/flac, до 25 МБ) транскрибуються через `Transcriber` у Factory картки від імені відправника. Без транскрибера чи при помилці кліп лишається з приміткою | `ConversationRouter#body` |
| Доставка | `sendMessage` у живу сесію картки (будить сесію); ingress `clickup:message:<id>` — повтор не дублюється | `@factory/runtime` диспетчер |
| Відповідь | Агент викликає `factory_conversation_reply({ platform, thread, text })`; ClickUp постить відповідь у тред коментаря токеном організації треду. Тред — `<taskId>:<commentId>:<orgId>`; тред іншої організації інструмент відхиляє, старий `<taskId>:<commentId>` відповідає від організації сесії | `packages/integrations/src/conversation/surface.ts`, `createClickUpChannel` |

## Що налаштувати

- Токен ClickUp організації (Налаштування › Підключення › ClickUp, підключає адміністратор; [ADR-0032](../../adr/0032-integration-tokens-belong-to-organization.md)) — краще **окремого сервісного акаунта** ClickUp (його згадують, щоб покликати агента; його коментарі не будять агента). У кожної організації свій бот.
- List задачі має бути у Settings › Intake і прив'язаний до проєкту; задача — мати картку.
- Публічний URL сервера (`MASTRACODE_PUBLIC_URL`) — для посилання прив'язки.

## Обмеження

- Транскрипцію не підключено (див. ADR-0018, «Наслідки»).
- Виявлення нових коментарів спирається на те, що коментар оновлює `date_updated` задачі.
- Відповіді в треді, де Factory ще не звертались, не читаються, навіть якщо згадують Factory.
- Згадка відправника у відповіді — текстова `@ім'я`, не тег ClickUp.
