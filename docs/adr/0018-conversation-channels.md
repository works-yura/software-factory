# 0018. Розмови з агентом: один провайдер-нейтральний канал, ClickUp — перший адаптер

Дата: 2026-11-11 · Статус: прийнято · Замінює: — · Коміти: `feat(integrations): provider-neutral conversation channel`, `feat(clickup): ClickUp task comments as a conversation channel`

**Контекст.** Upstream навчив Factory розмовляти в Slack: голосовий кліп у треді доходить до агента текстом (`8015cf5a55`), а неприв'язаному відправнику, що згадав агента, Factory публічно відповідає в треді карткою «підключи акаунт» (`e0bbdc6066`). У v4 Slack немає; задачі приходять з ClickUp, і люди пишуть у коментарях задачі. Переносити Slack-код дослівно — означає ще раз написати ту саму логіку для ClickUp, GitHub і GitLab.

**Рішення.**

Одна абстракція «розмова» в `@factory/integrations` (`src/conversation/`), провайдер — лише адаптер:

```text
@factory/integrations/conversation
  types.ts         InboundMessage, ConversationChannel (reply, download), Transcriber (порт), TranscriptionError
  router.ts        ConversationRouter — спільна логіка для всіх провайдерів
  connect-codes.ts ConnectCodes — одноразові коди прив'язки акаунта
  surface.ts       factory_conversation_reply (інструмент сесії), POST /web/channels/:platform/connect-code
        ▲
адаптери
  @factory/integration-clickup  conversation.ts  коментарі задач → InboundMessage; відповідь — reply у тред коментаря
  (пізніше) Slack, GitHub/GitLab-коментарі — той самий інтерфейс
```

`ConversationRouter.handle(message)` робить для будь-якого провайдера:

1. **Захист від петлі** — повідомлення власного акаунта Factory (`fromBot`) ігнорується.
2. **Дедуплікація** — `platform:id` у пам'яті; доставка в сесію йде через `commitRuleEvaluation` з ingress `platform:message:<id>`, тож повтор після рестарту теж не дублюється.
3. **Код прив'язки** — `connect FCT-XXXXXX` у повідомленні прив'язує акаунт провайдера до учасника Factory, що отримав код (одноразовий, 30 хв). Посилання в треді не несе ідентичності, тому його безпечно постити публічно.
4. **Неприв'язаний відправник**, що звернувся до Factory, отримує публічну відповідь у треді зі згадкою (раз на тред) — як `e0bbdc6066`.
5. **Картка** — адаптер знаходить картку за об'єктом треду (задача ClickUp). Немає картки, інша організація, немає живої сесії — Factory каже це в треді, а не мовчить.
6. **Голосові кліпи** — аудіовкладення транскрибуються через порт `Transcriber` у Factory картки від імені відправника; транскрипт замінює кліп. Не вийшло (нема ключа, задовгий, помилка провайдера, транскрипцію не налаштовано) — кліп лишається з приміткою, що це за файл і чому, як у `8015cf5a55`.
7. **Доставка** — рішення `sendMessage` (`idleBehavior: wake`) у живу сесію картки; агент відповідає інструментом `factory_conversation_reply` з посиланням на тред.

**Чому так.** Ports & Adapters, як у [ADR-0016](0016-intake-rules-ports-and-adapters.md): ядро не знає ClickUp, адаптер не знає про прив'язку, транскрипцію й сесії. Новий провайдер — це `ConversationChannel` + читання його повідомлень, без змін у роутері. Доставка йде тим самим шляхом диспетчера, що й інші події провайдерів (ідемпотентність, власник сесії, credentials).

**Відкинуто.**

- **Перенести Slack-код upstream** — v4 не має Slack; дублювання логіки в кожному провайдері.
- **Авто-прив'язка за email** — email у ClickUp і у Factory можуть не збігатися, а тиха прив'язка суперечить правилу «без тихих fallback».
- **Вебхук ClickUp** — локальний сервер без публічного URL; уся інтеграція ClickUp у v4 працює опитуванням.

**Наслідки.**

- Транскрипції у v4 поки немає (серверне диктування upstream чекає оновлення `@mastra/code-sdk`, див. `MIGRATION.md`), тож порт `Transcriber` не підключено: кліп доходить з приміткою «voice transcription is not set up on this Factory». Підключення — передати `transcriber` у `ClickUpIntegration`.
- Коди прив'язки живуть у пам'яті: після рестарту треба взяти новий.
- ClickUp-токен має належати окремому сервісному акаунту: коментарі цього акаунта вважаються «своїми» і не будять агента.

**Як додати провайдера.** Реалізувати `ConversationChannel` (`reply`, `download`), читати повідомлення провайдера в `InboundMessage` (`fromBot`, `addressedToBot`, `subject`), передавати їх у `ConversationRouter.handle`, віддати `createConversationReplyTool` у `sessionTools` і `buildConnectCodeRoute` у `routes`, додати платформу на сторінку `/connect/:platform`.
