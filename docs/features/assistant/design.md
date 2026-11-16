# Помічник — особистий деск звернень

Фаза 1 зроблена (гілка `feat/assistant-phase1`). Рішення: [ADR-0051](../../adr/0051-personal-assistant-requests-desk.md). Фаза 2 — ClickUp Chat як особисте джерело: [clickup-chat.md](clickup-chat.md). Фаза 3 — інструменти агента, підтвердження дій Factory, інструкції й навички, правила каналів, дайджести: [нижче](#фаза-3-інструменти-правила-дайджести) (гілка `feat/assistant-phase3`; бекенд і API, UI ще немає).

- **Що це.** Плаваюча кнопка на сторінках Factory відкриває панель «Помічник»: звернення людини в її поточній організації. Звернення людина приносить сама — вставляє текст чи скріншот (Ctrl+V), перетягує файли, пише «від кого» і посилання на першоджерело. Одне звернення — один тред.
- **Власник — пара `(orgId, userId)`.** Береться лише з сесії (`tenant`), ніколи з запиту. Чуже звернення, нотатка чи файл (іншої людини або тієї самої людини в іншій організації) — 404. Порожня половина власника відкидається до будь-якого запиту в БД.
- **Статуси.** `new` (агент ще дивиться) → `waiting_me` (агент відзвітував) / `waiting_factory` (спитали Factory чи передали картку) → `answered` (з фази 4, коли піде відповідь колезі) → `closed` (закриває людина). Нове повідомлення в закрите звернення не приймається.
- **Агент.** Один Mastra Agent, що створюється на кожен хід з моделлю власника; без контексту проєктів; з фази 3 — з інструментами власника, інструкціями й навичками людини (див. фазу 3). Пам'ять Mastra: ресурс `assistant:<orgId>:<userId>`, тред = id звернення. Картинки йдуть моделі як зображення (vision), PDF — файлом, текстові файли — текстом. Модель — обрана людиною з моделей організації або типова модель організації — той самий вибір, що й у нового чату Factory без власної типової моделі («вбудована типова» в Налаштуваннях › Моделі): модель типового режиму harness, якщо організація може її запустити, інакше типова модель першого підключеного провайдера в порядку `PROVIDER_DEFAULT_MODELS` (`resolveTenantProviderDefaultModel`, credentialScope `factory`). Окремого налаштування типової моделі на рівні організації немає — типові моделі задаються для кожної Factory. Невдалий хід ніколи не перемикається тихо на іншого провайдера: `last_error` зберігає класифіковану причину (JSON: `kind` — `rate_limit` (429, resource-exhausted, квота, немає кредитів) / `auth` (401/403) / `model_not_found` (404) / `overloaded` (5xx) / `no_model` / `unknown`, `modelId`, `status`, сирий `detail`). Тред показує заголовок із провайдером і моделлю («xAI · grok-4.5: ліміт вичерпано або немає кредитів»), що робити, кнопки «Повторити» (`POST requests/:id/retry` — хід на те, на що агент ще не відповів) і «Вибрати іншу модель» (Обліковий запис › Помічник), а сирий текст — під «Подробиці». Немає жодної моделі — `no_model`, статус лишається `new`.
- **Хід агента** йде після відповіді на запит (панель опитує, поки `analysing`). Помилка ходу записується в `lastError` і показується в треді; в лог іде лише id звернення, без вмісту.
- **Factory — лише через MCP Factory від імені людини.**
  - Доступ: Акаунт › Помічник › «Дозволити». Помічник — OAuth-клієнт власного сервера авторизації Factory (better-auth `oauthProvider`): реєстрація, PKCE, та сама сторінка згоди `/oauth/consent`, повернення на `/web/assistant/factory-access/callback`. Токени (access + refresh, `offline_access`) — у `assistant_factory_grants` конвертом `secret-encryption`. Access-токен оновлюється refresh-токеном.
  - Список Factory — документ виявлення `GET /web/factory/mcp` (ADR-0051 (а), `packages/mcp`).
  - «Спитати Factory X» — `factory_start_session` з питанням; «Перевірити відповідь» читає `factory_thread_read` бічної сесії; коли агент Factory відповів — відповідь іде в тред, помічник робить висновок, статус `waiting_me`.
  - «Передати у Factory X» — `factory_create_work_item` (опис — примітка людини, якщо є, далі що написали, від кого, першоджерело, назви файлів; примітка також видна в треді під подією), далі кожен файл — у вкладення картки тим самим bearer-токеном (`POST /web/factory/work-items/:id/attachments`). Картку можна передати один раз.
  - Права — людини: Глядач (без `run.start`) Factory не спитає й не передасть; відмову Factory помічник показує її словами (502 `factory_failed`).
- **Файли.** Байти — у наявному `AttachmentBlobStore` (за sha256), записи — `assistant_files`. Байти видаляються, лише коли на sha256 не посилається жоден файл помічника, жодне вкладення Factory і жоден аватар; і навпаки, видалення вкладення Factory не чіпає байти, які ще має помічник (`AttachmentService({ otherReferences })`). Без сховища файлів звернення з файлами відмовляються (503 з поясненням), текстові працюють.
- **Панель як inbox.** Ліворуч — список (рядок: крапка статусу, тема, жирна поки непрочитане, вік у кінці; фільтр за статусом). Праворуч — тред: заголовок (тема — перейменування на місці; від кого, першоджерело, коли створене; статус — Select з п'ятьох, цільова Factory — Combobox, типово Factory сторінки; «Закрити» (E) або «Відкрити знову»; решта — в меню «Ще»). Композер має режим: «Помічнику» (типово, з файлами), «Спитати Factory» (набране — питання), «Передати у Factory» (набране — примітка до картки); Enter надсилає в обраному режимі обраній Factory. Клавіші в панелі: J/K — наступне/попереднє, Enter — до відповіді, E — закрити й відкрити наступне, C — нове звернення (працюють і на українській розкладці). Нове звернення — як новий чат: порожній тред з одним рядком «що далі» і той самий композер, що в треді (фокус одразу в ньому; Ctrl+V — текст чи скріншот, файли кидаються будь-куди на панель, вкладення — картками з прев'ю; «+ Від кого» і «+ Посилання» — чипи в шапці композера, що розкриваються в маленьке поле; Enter надсилає, Shift+Enter — новий рядок; Escape чи тихий ✕ у шапці — скасувати). На телефоні — та сама будова: список, тред поверх нього; статус і Factory — у меню «Ще», режими — іконками.
- **Нотатки** — вкладка «Нотатки», нотатки людини в цій організації.
- **Налаштування** — Акаунт › «Помічник» (область `personal`): модель з моделей організації, скільки днів тримати закриті звернення (1–365, типово 30), доступ до Factory (дозволити / відкликати), «Очистити помічника».
- **Очищення.** Тригери: людину прибрали з організації або вона вийшла (усі шляхи better-auth: `remove-member`, `leave`, `remove`/`leave` довідника) — стирається помічник цієї організації; акаунт видалено (хук better-auth `databaseHooks.user.delete.after`; потоку видалення акаунта у Factory поки немає — хук є точкою, куди він прийде) — усіх організацій; «Очистити помічника»; щоденна задача терміну зберігання (закриті звернення, старші за термін власника — з тредом пам'яті й файлами). Порядок: відкликати OAuth-токени помічника → стерти пам'ять Mastra за ресурсом → звернення, треди, нотатки, налаштування, секрети → записи файлів і неспільні байти → тимчасова тека (у фазі 1 її немає: помічник не виконує команд) → запис аудиту `factory.assistant.cleared` (причина й кількість звернень/файлів, без вмісту). Помилка очищення після видалення учасника логується гучно й не скасовує видалення.

## Таблиці

`assistant_requests` (з фази 3 — `pending_action`), `assistant_messages` (тред для панелі: людина, агент, Factory, події «запитано/передано/запропоновано»), `assistant_notes`, `assistant_settings` (з фази 3 — `instructions`, `skills`, `digest_frequency`, `digest_hour`, `digest_time_zone`, `digest_last_at`, `digest_next_at`), `assistant_files`, `assistant_factory_grants`. Усі з `owner_org_id` + `owner_user_id`; створюються доменом `assistant` при старті (`ensureCollections`), міграцій даних не потрібно. Пам'ять агента — у сховищі Mastra memory (`mastra_threads`/`mastra_messages`) під ресурсом `assistant:<orgId>:<userId>`.

## Маршрути

`/web/assistant/*`: `requests` (GET, POST multipart/JSON), `requests/:id` (GET; PATCH — тема й статус, які людина ставить сама; закрите можна відкрити знову), `requests/:id/messages|close|retry|ask|check-answer|hand-over` (POST), `requests/:id/actions/:actionId/confirm|cancel` (POST, фаза 3), `files/:id/content`, `notes` (GET, POST), `notes/:id` (PATCH, DELETE), `settings` (GET, PUT), `skills` (GET, фаза 3), `models`, `factories`, `clear`, `factory-access/start` (POST), `factory-access/callback` (GET), `factory-access` (DELETE). Кожен запис — `self.write` (є в кожної ролі, зокрема Глядача). Маршрути монтуються лише на сервері з входом.

## Чого ще немає

- (б) `factory_ask` у MCP — помічник сам стартує бічну сесію; з фази 3 він опитує відповідь у фоні з тайм-аутом, далі — кнопка.
- (г) довгий доступ: access-токен прив'язаний до браузерної сесії, з якої людина дозволила доступ; після виходу треба дозволити знову. Для фази 1 (усе за дією людини) достатньо.
- (д) `factory_start_session` без репозиторію: у Factory без репозиторію «Спитати» відповідає, що ця Factory поки не приймає питань.
- Розділ «Помічник» в Акаунті відкривається зі сторінок Factory (як увесь Акаунт сьогодні), хоч дані не належать жодній Factory.
- Пошта, відповіді колегам — пізніше. ClickUp Chat (фаза 2) — [clickup-chat.md](clickup-chat.md). Дайджести — фаза 3, без листа.
- UI фази 3 (налаштування інструкцій, навичок, дайджесту, правил каналів; «Підтвердити/Скасувати» в треді) — наступний крок; API нижче.

## Де в коді

- Ядро: `packages/assistant-core/src/` — `storage.ts` (таблиці), `service.ts` (життєвий цикл, очищення, термін, пропозиції, правила, дайджести), `agent.ts` (Mastra Agent, пам'ять, інструкції), `tools.ts` (інструменти агента), `digest.ts` (розклад і таймер дайджестів), `factory-access.ts` (OAuth), `factory-client.ts` (MCP), `routes.ts`, `retention.ts`; межа залежностей — `boundary.test.ts`.
- Сервер: `packages/server/src/assistant/wiring.ts` (порти: моделі організації, сховище, аудит, хуки видалення, каталог навичок, таймер дайджестів), монтування — `packages/server/src/factory.ts`.
- MCP: документ виявлення — `packages/mcp/src/routes.ts` (`FACTORY_MCP_DISCOVERY_PATH`).
- Хуки видалення: `packages/auth-better-auth/src/team.ts` (`OrganizationEventRelay.onMemberRemoved/onUserDeleted`), `index.ts`.
- UI: `packages/assistant-ui/src/` (кнопка, панель, тред, нове звернення, нотатки, налаштування); у застосунку — `apps/ui/src/ui/domains/assistant/AssistantOverlay.tsx`, `ChatOverlays.tsx`, `AccountSettingsSection.tsx`; переклади — `apps/ui/src/ui/i18n/locales/{en,uk}/assistant.json`.

## Фаза 3: інструменти, правила, дайджести

Рішення й відступи — ADR-0051, розділ «Фаза 3». Зроблено бекенд і API; UI — наступний крок.

### Що перевикористано

- **Mastra `createTool`** (як у `harness-mastra`) і той самий Mastra Agent помічника, з `maxSteps`.
- **`FactoryClient` / MCP Factory від імені людини.** Новий лише метод `read` для наявних read-only інструментів MCP (`factory_list_work_items`, `factory_inspect_work_item`, `factory_list_attention`). «Спитати» й «передати» — наявні `askFactory` / `handOver`. У `packages/mcp` нічого не додано.
- **Каталог навичок Factory** — `listFactorySkills` з `harness-mastra`: той самий завантажувач і перевірка SKILL.md, що в сесій і в налаштуваннях навичок. Помічник отримує його портом `AssistantSkills`, бо межа пакета не дозволяє імпортувати `harness-*`.
- **Клієнт ClickUp, токен і курсори фази 2.** Читання на запит іде тим самим `ClickUpChatClient` з бюджетом викликів.
- **Цикл тиків фази 2** (як `startClickUpPolling` і `startAssistantRetention`) — для дайджестів.

### Інструменти агента

Будуються на кожен хід (`createAssistantTools`) і прив'язані до власника й звернення ходу. Власника модель не передає, тож чужого не видно.

| Інструмент | Що робить | Пише? |
|---|---|---|
| `assistant_search_requests` | свої звернення за текстом теми/відправника, статусом | ні |
| `assistant_read_request` | звернення й останні записи треду (не знімає «непрочитане») | ні |
| `assistant_list_notes` | свої нотатки | ні |
| `assistant_create_note` | нотатка людині (автор `agent`), за бажанням про це звернення | так, свої дані |
| `source_list_channels` | канали, які людина ввімкнула (режим ≠ `ignore`), з режимом і правилом | ні |
| `source_read_channel` | останні повідомлення ввімкненого каналу чи треду, зараз, особистим підключенням | ні |
| `factory_list_factories` | Factory, до яких людина має доступ | ні |
| `factory_find_work_items` | картки Factory (MCP `factory_list_work_items`) | ні |
| `factory_inspect_work_item` | картка докладно (MCP `factory_inspect_work_item`) | ні |
| `factory_list_attention` | що в Factory чекає людину | ні |
| `factory_session_status` | чи відповіла бічна сесія | ні |
| `factory_propose_ask` | **пропонує** спитати Factory | ні, лише пропозиція |
| `factory_propose_hand_over` | **пропонує** передати звернення карткою | ні, лише пропозиція |
| `assistant_read_skill` | текст навички, яку людина обрала (є, лише коли обрані навички є) | ні |

Відповідати колегам агент не може: такого інструмента немає.

### Підтвердження дій Factory

1. Агент викликає `factory_propose_*` → на звернення кладеться `pendingAction` `{ id, kind: 'ask'|'hand_over', factoryId, factoryName, question?, title?, note?, reason?, proposedBy: 'agent'|'rule', proposedAt }`, у тред — подія `proposed:<kind>:<Factory>` з питанням чи назвою. Статус не змінюється (`waiting_me`). Одна пропозиція на хід; нова замінює стару.
2. Тред показує пропозицію (`request.pendingAction`) з кнопками.
3. `POST /web/assistant/requests/:id/actions/:actionId/confirm` — виконує від імені людини (`askFactory` чи `handOver`), подія `confirmed:<kind>`. Дія знімається атомарно; повторне підтвердження — 409 `no_pending_action`. Помилка Factory (502 `factory_failed`) повертає пропозицію назад для повтору.
4. `POST …/cancel` — нічого не виконує, подія `cancelled:<kind>`.
5. Після «спитати» (з кнопки чи підтвердження) сервіс сам перевіряє бічну сесію кожні 20 с до 15 хв. Коли відповідь є — вона в треді, агент робить висновок (`waiting_me`). Після тайм-ауту — подія `answer_timeout`, далі «Перевірити відповідь».

### Інструкції й навички

- ~~`instructions`~~ — з'єднано з базовим документом (див. «Сторінка налаштувань і прозорість» нижче): старий текст один раз дописується в документ людини розділом «My instructions».
- `skills` — до 10 назв з каталогу навичок Factory (`GET /web/assistant/skills`). Агент бачить назву й опис кожної обраної і завантажує текст інструментом `assistant_read_skill` — так само, як сесії Factory.
- Каталог — рівня розгортання (вбудовані, `factory-skills/` застосунку, `MastraFactory({ skills })`), оригінали без правок проєктів. Навичок рівня організації у Factory немає. Навичка, яку прибрали з каталогу, тихо випадає з ходу.

### Правила каналів (ClickUp)

Колонка `assistant_source_channels.rule`:

- `analyse` — типово: розбір агента;
- `analyse_and_ask:<factoryId>` — розбір, потім Factory питається сама (подія `rule:analyse_and_ask`):
  - лише за ввімкненням людини, ніколи не типово;
  - Factory має бути доступна людині (перевіряється при збереженні: 409 `factory_not_connected` / 404 `factory_not_found`);
  - до 10 автопитань на людину за добу, понад ліміт — пропозиція `proposedBy: 'rule'`;
  - якщо Factory недоступна в момент питання — подія `auto_ask_failed`;
- `digest_only` — звернення без ходу агента (подія `not_analysed:digest`), ліміт ходів не витрачається; потрапляє в дайджест.

Режим (`ignore`/`addressed`/`watch`) і правило незалежні.

### Дайджести

- `digest: { frequency: 'off'|'hourly'|'daily', hour: 0–23, timeZone: IANA }`, типово `off`, 9:00, UTC.
- `hourly` — щогодини о :00. `daily` — щодня о `hour` у `timeZone`.
- Таймер — тік раз на хвилину (`startAssistantDigests`), до 20 людей за тік.
- Дайджест — звернення з `source: 'digest'`, тема «Daily digest · …». Агент підсумовує відкриті звернення людини (до 40): статус, тема, від кого, останні слова; звернення з `digest_only`-каналів позначені. Якщо відкритих немає, звернення не створюється, наступний час усе одно ставиться. Листа немає.

### Ліміти

`DEFAULT_ASSISTANT_LIMITS` у `service.ts`:

| Ліміт | Значення |
|---|---|
| кроків моделі за хід | 8 |
| автопитань за добу | 10 |
| опитування відповіді | кожні 20 с, до 15 хв |
| звернень у дайджесті | до 40 |

`callsPerRead` ClickUp — 3 виклики на одне читання агентом, до 30 повідомлень.

### API для UI (налаштування й тред)

- `GET /web/assistant/settings` → `{ settings: { modelId, retentionDays, instructions, skills, digest: { frequency, hour, timeZone } }, digestSchedule: { lastAt, nextAt } }`.
- `PUT /web/assistant/settings` — будь-яка підмножина: `{ modelId?, retentionDays?, instructions?, skills?: string[], digest?: { frequency?, hour?, timeZone? } }` → те саме, що GET. Помилки 400: `instructions_too_long`, `too_many_skills`, `unknown_skill`, `invalid_digest`.
- `GET /web/assistant/skills` → `{ skills: [{ name, description }] }` — каталог для вибору.
- `GET /web/assistant/requests/:id` — `request.pendingAction` (`null` або пропозиція, `proposedAt` ISO). Пропозиція є і в списку `GET /web/assistant/requests`.
- `POST /web/assistant/requests/:id/actions/:actionId/confirm` → `{ request }`; 409 `no_pending_action`, 409 `factory_not_connected`, 502 `factory_failed`.
- `POST /web/assistant/requests/:id/actions/:actionId/cancel` → `{ request }`; 409 `no_pending_action`.
- `GET /web/assistant/sources` → у кожного каналу ще `rule` (`analyse` / `analyse_and_ask:<factoryId>` / `digest_only`).
- `PUT /web/assistant/sources/clickup/channels/:workspaceId/:channelId` `{ mode?, rule? }` (хоча б одне); 400 `invalid_rule`.
- Нові рядки треду (author `event`):
  - `proposed:<ask|hand_over>:<Factory>\n<текст>`;
  - `confirmed:<kind>`, `cancelled:<kind>`;
  - `rule:analyse_and_ask`, `auto_ask_failed\n<чому>`;
  - `answer_timeout`, `not_analysed:digest`, `digest:<n>`.
- Нове джерело звернення — `digest`.

## Сторінка налаштувань і прозорість

Відповідь на «де редагування навичок помічника? там може бути що завгодно, а я й не знатиму». Гілка `feat/assistant-settings-transparency`.

- **Сторінка** Налаштування › «Помічник» (`/factories/:id/settings/assistant`, область `personal`): Модель, Поведінка, Навички, Джерела, Проактивність, Доступ до Factory, Що бачить агент, Зберігання. Відкривається з навігації налаштувань, з Акаунта (посилання) і шестернею в заголовку панелі. Старі посилання `account#assistant` переводяться сюди.
- **Модель.** Пікер — той самий `ProviderModelPicker`, що в Налаштуваннях › Моделі (apps/ui передає його в `AssistantModelSettings` слотом `renderPicker`), побудований на `groups` з `GET /models`: групи з обліковими даними й доступністю, типова позначена, безкоштовні з позначкою, неробочі моделі сірі з причиною, група без облікових даних веде на підключення. Під ним — на чому реально піде хід і чому, «лише безкоштовні моделі працюють», стан кожного провайдера (з ходів і перевірок) і «Перевірити модель».
- **Поведінка.** Базові інструкції — один Markdown-документ. Типовий — `packages/assistant-core/src/base-instructions.md` (сервер бандлиться, тож модуль `base-instructions.ts` генерується скриптом `gen:base-instructions`, тест ловить розбіжність). Версія людини — `assistant_settings.base_instructions` (+ `base_instructions_updated_at`); «Повернути типову» стирає її. Редактор — CodeEditor (markdown) + MarkdownRenderer + CodeDiff проти типового. Після документа — перелік навичок і **запобіжник**, якого правка не прибирає: «звітуй лише людині; дії у Factory — лише пропозиції».
- **Навички.** Каталог Factory з перемикачами (`settings.skills`), повний текст у редакторі навичок Factory (`SkillSimpleForm` з kit). Збереження пише **правку лише для помічника** (`assistant_skills`, `kind: override`), оригінал і правки Factory не змінюються; позначка «змінено» й «Повернути оригінал». Власні навички (`kind: personal`, до 30) — створити й видалити. Агент читає спершу текст людини, потім каталог. Таблиця з власником, стирається разом з помічником.
- **Що бачить агент** — `GET /agent-preview`: увесь системний промпт, що піде в наступний хід, його версія (sha256, 12 знаків) і кожен інструмент з описом і родом: `read` / `write_own` (нотатка) / `proposal` (лише пропозиція).
- **Подробиці ходу.** Кожна відповідь агента зберігає `details`: модель, версію інструкцій, навички, виклики інструментів (назва, аргументи й відповідь коротким JSON до 500 знаків, помилка, тривалість). Під відповіддю — згорнуте «Подробиці ходу», виклики намальовано так, як у сесіях Factory (`ActivityItem` + `ToolCallBody` з kit).
- **Тред.** Пропозиція (`pendingAction`) — картка з «Спитати»/«Передати» і «Скасувати» (існуючі confirm/cancel); рядки подій фази 3 (`proposed:…`, `confirmed`, `cancelled`, `rule:analyse_and_ask`, `auto_ask_failed`, `answer_timeout`, `not_analysed:digest`, `digest:<n>`) мають власні підписи.

API:

- `GET /web/assistant/behavior` → `{ behavior: { document, defaultDocument, customized, updatedAt, version } }`; `PUT {document}` (400 `empty`, `instructions_too_long` — до 20 000); `DELETE` — типова. `PUT /settings` з `instructions` → 400 `instructions_moved`.
- `GET /web/assistant/skills` → `{ skills: [{ name, description, origin: 'factory'|'personal', overridden, enabled }] }`; `GET /skills/:name` → `{ skill: { …, instructions, original, updatedAt } }`; `PUT /skills/:name {description, instructions}` — правка чи текст власної; `POST /skills {name, description, instructions}` (400 `invalid_skill_name`/`invalid_skill`, 409 `skill_exists`); `DELETE /skills/:name` → `{ reverted, deleted }`.
- `GET /web/assistant/agent-preview` → `{ preview: { systemPrompt, version, modelId, skills, tools: [{ name, description, kind }] } }`.
- `GET /web/assistant/model-status` → `{ providers: [{ provider, modelId, state: 'ok'|<kind збою>, detail, at }] }` — останній хід чи перевірка на провайдера (у пам'яті), інакше останні `lastError` звернень.
- `POST /web/assistant/model-test {modelId?}` → `{ check: { ok, modelId, reply, failure, durationMs } }`; до 20 на годину (409 `too_many_checks`).
- `GET /web/assistant/requests/:id` — у `messages[].details` подробиці ходу агента (`null` в інших і старих).

