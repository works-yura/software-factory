# 0016. Правила надходження: порти й адаптери; картку правила ставлять маршрути

Дата: 2026-11-11 · Статус: прийнято · Замінює частини [ADR-0015](0015-intake-rules-and-audits.md) (шари, розміщення картки, «Як додати») · Коміти: `994c4e0` (шари, маршрути, ідемпотентність), `37d71e3`, `1f44b1f` (UI) · Частково замінено: [ADR-0020](0020-intake-sources-and-routes.md) (куди йде картка — лише маршрути)

**Контекст.** Перша версія ([ADR-0015](0015-intake-rules-and-audits.md)) мала правильну модель (тригер → політика → дія, реєстри видів), але все лежало в HTTP-шарі (`packages/api/src/intake-rules/`): рушій не можна було взяти без API, а тригер на Mastra — без сервера. Дія `create-card` сама обирала дошку й фазу, в обхід «Маршрутів надходження», тож рішення «куди ставити нову картку» жило у двох місцях. Повторна доставка того самого спрацювання (повтор кроку воркфлоу після збою) могла створити дві картки. Потрібно, щоб нові тригери (події PR, фази карток, ClickUp), дії (`notify`, картки за знахідками) й політики додавалися без переписування.

**Рішення.**

Шари (порти й адаптери):

```text
@factory/core        домен і порти, без вводу-виводу
  intake/rule.ts       IntakeRuleRecord, IntakeRuleFireRecord, IntakeTriggerFired, IntakeRuleRepository (порт сховища)
  intake/kinds.ts      IntakeTriggerKind · IntakeActionKind · IntakePolicyKind (Strategy) + IntakeKindRegistry (Registry), parseWith
  intake/events.ts     IntakeEvent, IntakeEventSource (порт потоку подій, Observer)
  intake/errors.ts     IntakeError з кодами: invalid_config · unknown_kind · target_unavailable · trigger_unavailable
  intake/configs.ts    схеми конфігів вбудованих видів (contracts їх реекспортує)
  intake/card-origin.ts metadata.intakeRule → факти source.kind=intake_rule, intake.rule, intake.trigger
        ▲
@factory/runtime     застосунковий сервіс
  intake-rules/engine.ts       IntakeRuleEngine: fire · validate · sync · armAll · preview · inspect
  intake-rules/policies.ts     skip-if-open, always
  intake-rules/event-trigger.ts eventTriggerKind: тригер-спостерігач над IntakeEventSource
        ▲
адаптери
  @factory/work-items  intake-create-card.ts   дія create-card через createFactoryWorkItem
  @factory/server      intake/schedule-trigger.ts  тригер schedule над Mastra Schedules + воркфлоу (Adapter)
                       intake/setup.ts         корінь композиції: єдине місце, що називає конкретні види
  @factory/store       intake-rules/base.ts    IntakeRulesStorage implements IntakeRuleRepository
        ▲
@factory/api         intake-rules/routes.ts   тонкий HTTP: DTO ↔ рушій, IntakeError → 422/503
```

Шаблони й чому:

- **Strategy + Registry** — тригер, дія й політика є взаємозамінними стратегіями, що шукаються за назвою виду. Новий вид не змінює рушій (відкрито для розширення).
- **Ports & Adapters** — ядро й рушій не знають Mastra, HTTP чи сховища; адаптери залежать від портів, а не навпаки (інверсія залежностей). Рушій тестується з подвійниками.
- **Adapter над Mastra** — таймер, захоплення між репліками й журнал запусків — у Mastra `Schedules`; свого cron немає.
- **Command + ідемпотентність** — дія є командою, що повертає результат. Спрацювання несе `fireKey` (для розкладу — id запуску воркфлоу, тобто id захоплення планувальника; для події — її id). Рушій повертає вже записане спрацювання з тим самим ключем; `create-card` повертає картку, яку це спрацювання вже створило (якщо збій стався між карткою й записом). Колонка `fire_key` у `factory_intake_rule_fires` (додається сама, старі рядки — `null`).
- **Observer для подій** — подійний тригер підписується на `IntakeEventSource`; адаптер провайдера публікує туди події.
- **Типізовані помилки домену** — вид і рушій кидають `IntakeError`; лише API перекладає код у статус.

Одне рішення про розміщення: картка правила несе `metadata.intakeRule` (`id`, `name`, `triggerKind`, `firedAt`, `fireKey`). `cardRuleFacts` читає це як `source.kind = intake_rule`, `intake.rule = <id правила>`, `intake.trigger = <вид тригера>`. `createFactoryWorkItem` ставить картку так: **спершу маршрути надходження** (перший увімкнений, що підходить), **потім дошка й фаза правила** (`defaultPlacement`, як дошка List у ClickUp), інакше — «Розробка». У редакторі маршрутів є тип «картка правила надходження» й умови «Правило» та «Тригер правила».

**Наслідки.**
- Маршрут без умов (`when: null`, «будь-яка нова картка») тепер забирає й картки правил. Щоб картки правила йшли на його дошку, такий маршрут має виключати їх або стояти після маршруту з умовою «Правило».
  *Оновлено з переносом upstream `6cbcaa9b4c`:* маршрут без умов тепер пробується **після** цілі правила (і дошки списку ClickUp), бо кожен проєкт отримав такий маршрут за замовчуванням («Усе інше йде у Розробка › Вхідні»). Картки правила потрапляють на його дошку, якщо їх не взяв маршрут з умовою.
- Якщо маршрут чи дошка правила відмовляє в переході у фазу, спрацювання записується як `failed` (картку відкочено), а не лишається у «Вхідних» з приміткою.
- `packages/api` більше не експортує рушій; `setupIntakeRules` — у `packages/server/src/intake/setup.ts`.

**Як додати**
- **Тригер за часом чи зовнішнім механізмом** — реалізувати `IntakeTriggerKind` (`parse`, `describe`, `start(sink)`, `arm`, `disarm`, за потреби `nextFires`/`timeZone`; передавати `fireKey`) як адаптер; зареєструвати в `packages/server/src/intake/setup.ts`; форма — `registerIntakeTriggerForm` (`apps/ui/.../intake-rules/builtinForms.ts`); тест.
- **Подійний тригер** («PR змерджено»): адаптер, що публікує події провайдера в `IntakeEventSource` (з id події), і `eventTriggerKind({ kind, label, source, schema, describe, matches })` у корені композиції; форма; тест із подвійником джерела (див. `packages/runtime/src/intake-rules/engine.test.ts`).
- **Дію** (`notify`, картки за знахідками): `IntakeActionKind` (`parse`, `describe`, `problems?`, `run` — ідемпотентно за `fired.fireKey`); реєстрація в `setup.ts`; форма `registerIntakeActionForm`; тест.
- **Політику**: `IntakePolicyKind` (`decide`) у `packages/runtime/src/intake-rules/policies.ts` чи поруч з адаптером; реєстрація в `setup.ts`.
- **Тип аудиту**: як у [ADR-0015](0015-intake-rules-and-audits.md) — рядок у `AUDIT_PROFILES`, чекліст `references/<вид>.md` у скілі `audit-run`, рядок у його таблиці.

**Альтернативи.** Лишити все в `api` — відкинуто: рушій прив'язаний до HTTP, а нові тригери тягнули б Mastra в API. Окремий пакет `intake-mastra` для тригера — відкинуто поки що: сервер уже є коренем композиції й залежить від Mastra, а `harness-mastra` — про агентів, не про надходження. Власна таблиця «вже оброблених» замість `fire_key` — відкинуто: журнал спрацювань і так зберігає кожне спрацювання.
