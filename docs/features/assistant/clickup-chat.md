# Помічник — ClickUp Chat як особисте джерело (фаза 2)

Рішення: [ADR-0051](../../adr/0051-personal-assistant-requests-desk.md), загальний опис помічника — [design.md](design.md). Код: `packages/assistant-source-clickup`.

## Що насправді пропонує ClickUp Chat API (перевірено 2026-11-15)

Звіряли з офіційною документацією на developer.clickup.com і специфікацією v3 [`ClickUp_PUBLIC_API_V3.yaml`](https://developer.clickup.com/openapi/ClickUp_PUBLIC_API_V3.yaml) (насправді JSON; посилання є на сторінці [open-api-spec](https://developer.clickup.com/docs/open-api-spec)). Справжнім токеном ClickUp не викликали.

Сам ClickUp пише про Chat API: «The Chat API endpoints are experimental and subject to change at any time» ([docs/chat](https://developer.clickup.com/docs/chat)). Обмеження за тарифом для чату не зазначено ([apis-available-by-plan](https://developer.clickup.com/docs/apis-available-by-plan)).

### Є

| Що | Як | Посилання |
|---|---|---|
| Хто власник токена | v2 `GET /api/v2/user` → `{ user: { id (число), username, email } }` | [getauthorizeduser](https://developer.clickup.com/reference/getauthorizeduser) |
| Workspaces і їхні учасники | v2 `GET /api/v2/team` → `teams[].members[].user`. `team_id` у v2 — це `workspace_id` у v3 | [getauthorizedteams](https://developer.clickup.com/reference/getauthorizedteams), [v2 і v3](https://developer.clickup.com/docs/general-v2-v3-api) |
| Канали, DM і групові DM | `GET /api/v3/workspaces/{ws}/chat/channels`, один список. `type` = `CHANNEL` / `DM` / `GROUP_DM`. Параметри: `cursor`, `limit` (1–100), `is_follower`, `include_closed`, `with_message_since`, `channel_types` (значення не описані) | [getchatchannels](https://developer.clickup.com/reference/getchatchannels) |
| Повідомлення каналу | `GET …/chat/channels/{id}/messages`: лише верхній рівень, **найновіші першими**, `cursor`/`limit`, `content_format` `text/md` чи `text/plain`. Поля: `id`, `content`, `date` (epoch ms), `user_id` (рядок), `parent_channel`, `replies_count` | [getchatmessages](https://developer.clickup.com/reference/getchatmessages) |
| Відповіді в треді | `GET …/chat/messages/{id}/replies`, найновіші першими, з курсором; у відповіді є `parent_message` | [getchatmessagereplies](https://developer.clickup.com/reference/getchatmessagereplies) |
| Згадки | `GET …/chat/messages/{id}/tagged_users` — хто згаданий | [getchatmessagetaggedusers](https://developer.clickup.com/reference/getchatmessagetaggedusers) |
| Учасники каналу | `GET …/channels/{id}/members` і `/followers` | [getchatchannelmembers](https://developer.clickup.com/reference/getchatchannelmembers) |
| Запис | створити повідомлення чи відповідь, реакції, DM (`POST …/channels/direct_message`) | [createdirectmessagechatchannel](https://developer.clickup.com/reference/createdirectmessagechatchannel) |
| Вхід | особистий токен (`Authorization: pk_…`, без `Bearer`, не спливає) або OAuth (`Bearer`). Специфікація v3 має одну схему, заголовок `Authorization`, на всі ендпоінти, зокрема чат | [authentication](https://developer.clickup.com/docs/authentication) |
| Ліміти | на токен за хвилину: 100 (Free, Unlimited, Business), 1 000 (Business Plus), 10 000 (Enterprise). Відповідь 429 із заголовками `X-RateLimit-Limit`, `-Remaining`, `-Reset` (unix-секунди) | [rate-limits](https://developer.clickup.com/docs/rate-limits) |

Конверт сторінки — `{ "data": [...], "next_cursor": "…" }`; помилки — `{ status, message, trace_id, timestamp }`.

### Немає (або не описано)

- **Webhooks на чат немає.** У списку подій лише задачі, списки, папки, простори, цілі; найближче — `taskCommentPosted`, і це коментарі задач ([webhooks](https://developer.clickup.com/docs/webhooks)). Тому читаємо опитуванням.
- **Фільтра «з часу» для повідомлень немає.** Читаємо з найновіших назад до курсору (дата останнього взятого повідомлення).
- **Вкладень у повідомленнях чату немає.** У схемі повідомлення немає поля для файлів. Ендпоінти v3 `/attachments` працюють лише для задач і кастомних полів ([getparententityattachments](https://developer.clickup.com/reference/getparententityattachments)).
- Як згадка виглядає в `content` (Markdown чи `@`), не описано. Тому згадку перевіряємо через `tagged_users`, окремим викликом на повідомлення.
- Не описано: значення `channel_types` і `parent.type`, одиниці `with_message_since`, чим `next_cursor` позначає останню сторінку.
- Формат посилання на повідомлення в застосунку не описано. Посилаємося на канал, `https://app.clickup.com/{ws}/chat/r/{channel}`. Цей формат узято з адрес застосунку, не з документації.

## Що зроблено

- **Підключення — особистий API-токен людини** (`pk_…`). OAuth вимагав би зареєструвати застосунок ClickUp із секретом на сервері й робити це для кожного розгортання. Для читання власних DM особистого токена досить. OAuth — пізніше, ним можна замінити токен без зміни решти.
  - Токен перевіряється одразу: `GET /user` (хто це) і список каналів.
  - Зберігається конвертом `secret-encryption` у `assistant_source_connections`, власник `(orgId, userId)`.
  - Жоден маршрут токена не повертає.
- **Канали.** Канали, DM і групові DM усіх workspaces токена. Список оновлюється раз на годину і за кнопкою «Прочитати зараз».
  - **Як у сайдбарі ClickUp.** Список читається двічі: усі канали (без `is_follower` — це фільтр, типово `false`; невідомі параметри ClickUp мовчки ігнорує, [див. відповідь ClickUp](https://feedback.clickup.com/public-api/p/clickup-chat-api-v3-channel-filtering-issue)), а потім `is_follower=true`. Крім того, для кожного каналу `…/channels/{id}/followers` ([getchatchannelfollowers](https://developer.clickup.com/reference/getchatchannelfollowers)): канал у сайдбарі, якщо його дав фільтр **або** людина є серед followers. Обидва джерела видно окремо в діагностиці. Рядки, збережені до того, як з'явилися ці факти (`following` = null), перечитуються на найближчому опитуванні, а не через годину. Типово показано лише сайдбар (канали, за якими людина стежить, і DM, які вона не сховала, `is_hidden`). Решта схована під «Показати всі (N)», а пошук шукає по всіх.
  - **DM**: живий `name` — буквально «DM», тож імена людей беремо з `…/channels/{id}/members` (самої людини там немає), а аватар — з `profilePicture` учасника workspace. Обов'язкові в `ChatSimpleUser` лише `id` і `email` ([getchatchannelmembers](https://developer.clickup.com/reference/getchatchannelmembers)), тому ім'я без `name`/`username` береться з учасників v2 `/team`; приймаються також голі id і `{user:{…}}`. Груповий DM називається іменами учасників через кому.
  - **Канали розташувань.** Канали Space, Folder чи List мають `parent {id, type}`, де 4 — Space, 5 — Folder, 6 — List (так типи нумерує Docs API ClickUp; специфікація чату каже лише «number», на живих даних не перевірено). Шлях «Простір › Папка › Список» беремо з v2 `GET /list|folder|space/{id}`; приховану папку списку без папки пропускаємо. Тому однакові «#Bugs» різняться другим рядком і позначкою «Канал списку / папки / простору».
  - **Ліміт.** Людей, followers і шляхи беремо до `detailsPerListing` (15) каналів за **кожне** опитування (не лише при читанні списку): спершу ще не описані, потім сайдбар. Вдалий результат оновлюється раз на добу.
  - **Невдача видима.** Якщо ClickUp не дав людей / шлях / followers (код HTTP, мережева причина або `empty`), код зберігається в `details_error` і рядок у налаштуваннях каже «Не вдалося отримати учасників (код 403)». Спроба повторюється через `detailsRetryMs` (10 хв).
  - **Мережа.** `fetch failed` повторюється двічі з паузою 0,5 с і 1 с (так само 5xx). Якщо не вдалося, помилка — `ClickUp could not be reached (ECONNRESET) after 3 tries.` з `err.cause.code`.
  - «Усі DM: …» ставить один режим усім DM і груповим DM: `PUT /web/assistant/sources/clickup/dms {mode}`.
  - Типовий режим нового каналу — «вимкнено», DM і групового DM — «коли звертаються».
  - Режим людини зберігається; канал, який зник, позначається, а не видаляється.
- **Режими** (`ignore` / `addressed` / `watch`):
  - **стежити** — кожне нове повідомлення й відповідь;
  - **коли звертаються** — DM; згадка людини (`tagged_users`); відповідь у треді, де людина писала (корінь чи відповідь — її).
  - Відповідь у треді з відкритим зверненням береться за будь-якого режиму, крім вимкненого.
  - Власні повідомлення людини лише додаються до відкритого звернення як контекст, без ходу агента, і звернення ніколи не починають.
  - **Історію не читаємо:** перше читання після ввімкнення лише ставить курсор.
- **Звернення з повідомлень.** Ключ прив'язки — `clickup:<workspace>:<channel>:<корінь треду>`; ідемпотентність — за `clickup:<workspace>:<message>` (таблиця `assistant_source_messages`, унікальний ключ на власника).
  - Новий тред → нове звернення: від кого (ім'я учасника workspace), посилання на канал. Тему пише агент першим рядком `Topic: …`.
  - Нове повідомлення в треді відкритого звернення додається до нього (автор `source` з `fromName`).
  - У треді закритого звернення відкривається нове з `previousRequestId` і подією `continues:<id>`.
  - Ходи агента одного звернення йдуть по черзі.
- **Файли.** API файлів чату не дає. Беремо лише посилання на файли ClickUp у Markdown повідомлення (`![…](https://…clickup-attachments.com/…/x.png)`) і завантажуємо їх у `assistant_files`.
  - Токен іде лише на хости ClickUp.
  - **На живих даних не перевірено:** чи кладе ClickUp такі посилання в `content` скріншотів, вставлених у чат.
- **Опитування й ліміти** (`DEFAULT_POLL_LIMITS`):
  - людину опитуємо раз на 2 хв;
  - за один прохід — до 40 викликів ClickUp, до 10 каналів (першими ті, що читалися найдавніше), до 3 сторінок по 50 повідомлень на канал;
  - до 20 ходів агента на людину за годину; понад це повідомлення зберігаються з подією `not_analysed:limit`, без моделі;
  - після помилок інтервал подвоюється, до 30 хв; на 429 чекаємо до `X-RateLimit-Reset`;
  - на 401 підключення стає `rejected` і опитування зупиняється, доки людина не підключиться знову;
  - треди старші за 14 днів більше не відстежуються на відповіді.
  - Опитуються лише люди з активним підключенням; після відключення чи очищення рядка немає, і опитування припиняється.
  - Опитування, яке вже йде, перед кожним записом перевіряє, що підключення ще є.
- **Звітує лише людині.** У ClickUp нічого не пишемо: ні відповідей, ні реакцій, ні позначок «прочитано».
- **Очищення.**
  - «Очистити помічника», вихід чи видалення з організації, видалення акаунта: спершу OAuth-доступ до Factory, потім особисті джерела (токен ClickUp, канали, курсори, треди), далі за порядком ADR.
  - «Відключити» стирає лише підключення; звернення лишаються до закриття і терміну зберігання.
  - Термін зберігання стирає закрите звернення разом з його ключами повідомлень.

## Таблиці

- `assistant_source_connections` — токен (зашифрований), акаунт ClickUp, стан синхронізації, `next_poll_at`, кількість невдач.
- `assistant_source_channels` — канал/DM, режим, курсор (`cursor_at`), остання синхронізація і помилка, `gone`.
- `assistant_source_threads` — корінь треду, `replies_count`, курсор відповідей, `involves_me`.
- У ядрі:
  - `assistant_source_messages` — ідемпотентність;
  - нові колонки `assistant_requests.source_key` і `previous_request_id`, `assistant_messages.from_name`.

Колонки додаються самі (`ensureCollections` робить `ALTER TABLE ADD COLUMN`), міграцій даних немає.

## Маршрути

`/web/assistant/sources` (GET) і `/web/assistant/sources/clickup` з такими діями:

- `POST {token}` — підключити;
- `DELETE` — відключити;
- `POST …/sync` — прочитати зараз;
- `PUT …/channels/:workspaceId/:channelId {mode?, rule?}` — змінити режим і/або правило для нового звернення (фаза 3: `analyse` / `analyse_and_ask:<factoryId>` / `digest_only`, див. [design.md](design.md#фаза-3-інструменти-правила-дайджести)).

Кожен запис — `self.write`.

`GET /web/assistant/sources/clickup/diagnostics` — лише про власне підключення того, хто питає (інша людина чи інша організація отримує 409 `not_connected`). Відповідь `{ diagnostics: { connection, channels, lastRead } }`:

- `channels` — лічильники зі збереженого списку: за типом, `followingByFilter` (фільтр `is_follower`), `followerByEndpoint` (`…/followers`), `inSidebar`, `dmsWithPeople` / `dmsWithoutPeople` / `dmsWithUnnamedPeople`, `locationsWithPath`, `neverDescribed`, `lookupFailures` за кодом (`members:403`…);
- `lastRead` — останнє читання (`connect` / `poll` / `read`): по кожному виклику `endpoint` (без id), `status` (0 — мережа), `attempts`, `errorCode`, `count`, `nextCursor`, `keys`, `itemKeys`, `itemKinds`, `enums` (лише `type`, `visibility`, `parent.type`, `is_hidden`, `archived`, `channel_type`… і шаблони `links.*` з `{id}`).

Імен, email, id, тексту повідомлень і токена там немає. Ті самі рядки (крім читання повідомлень) пишуться в лог як `[assistant] clickup.call {…}`, невдалі описи — `[assistant] clickup.details {…}`.

## UI

Акаунт › «Джерела» (область `personal`, одразу під «Помічник»), `packages/assistant-ui/src/AssistantSources.tsx`:

- поле токена й «Підключити»;
- «Підключено як …», «Прочитати зараз», «Відключити» з підтвердженням;
- список чатів, у кожного Select режиму, час останнього читання й помилка.

Переклади — `assistant.json` (`sources.*`) і `settings.json` (`account.assistantSources`).

Тред звернення в панелі показує повідомлення джерела (автор `source`, `fromName`) і події `continues:` / `not_analysed:limit` так само, як решту. Окремий вигляд для них — справа редизайну треду (`RequestThread.tsx`).

## Як спробувати

1. ClickUp → аватар → **Settings › Apps** → **API Token** → «Generate», скопіювати `pk_…` (особистий токен; він бачить те саме, що й людина).
2. Factory → Налаштування → Акаунт → «Джерела» → вставити токен → «Підключити».
3. Обрати режим для DM чи каналу («Усе» або «Коли звертаються»). Писати в нього з іншого акаунта, після ввімкнення.
4. Через ~2 хв (або «Прочитати зараз») у панелі «Помічник» з'явиться звернення з розбором агента.
