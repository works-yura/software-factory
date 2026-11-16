# Помічник — ClickUp Chat як особисте джерело (фаза 2)

Рішення: [ADR-0051](../../adr/0051-personal-assistant-requests-desk.md), загальний опис помічника — [design.md](design.md). Код: `packages/assistant-source-clickup`.

> **З 2026-11-16 звернення з ClickUp створює лише тег людини** (`#помічник …`): режимів каналів і правил більше немає. Див. [«Тег»](#тег-поправка-2026-11-16) нижче. Розділи про режими, «коли звертаються» й правила описують те, що було до поправки.

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
2. Factory → Налаштування → Помічник → «Джерела» → вставити токен → «Підключити» (або «Використати підключення організації», якщо його токен — ваш акаунт).
3. Зачекати одне опитування (~2 хв або «Прочитати зараз»): перше читання ставить курсори.
4. У будь-якому чаті написати `#помічник оціни це` (у треді — відповіддю в ньому). Через ~2 хв (або «Прочитати зараз») у панелі «Помічник» з'явиться звернення: попередні повідомлення чи тред цитатою, «оціни це» — інструкція, далі розбір агента. Звичайні повідомлення звернень не створюють.

## Імена авторів і вкладення (2026-11-16)

- **Імена.** Спершу учасники workspace (v2 `/team`), потім люди каналу: збережені з його опису, а якщо там немає — один виклик `…/channels/{id}/members` у межах бюджету. Гості й люди спільного DM учасниками workspace не є. Невідомий автор лишається без імені (`from: null`), сирий id не показується. Учасник без `username` і email у карту імен не потрапляє.
- **Вкладення повідомлення** (`messageAttachments`) — посилання на файли ClickUp у Markdown і записи будь-якого поля вкладень (`attachments`, `files`, `attachment`) у формі вкладень задач v2 (`url_w_host` / `download_url` / `url`, `title` / `name` / `file_name`, `mimetype`). Беремо лише хости ClickUp, кожен файл один раз. Специфікація чату такого поля не описує; щойно жива відповідь його покаже (його видно в `keys` діагностики), воно береться без змін коду.
- **Опитування** завантажує ці файли у звернення (`assistant_files`). Тред показує їх картками, і вони лежать у теці звернення.
- **`source_read_channel`** віддає агенту `attachments: [{ name, url }]`, а завантажує він їх `assistant_download_to_workspace` — токеном людини, без підтвердження (`ClickUpChatSource.download`).

## Тег (поправка 2026-11-16)

Рішення — [ADR-0051, поправка 2026-11-16](../../adr/0051-personal-assistant-requests-desk.md). Режими каналів і правила прибрано. Звернення з ClickUp створює **лише тег** людини. Нижче — як це зроблено; розділи вище про режими й правила описують те, що було до поправки.

- **Тег.** Регулярний вираз із прапорцями `iu` (`packages/assistant-source-clickup/src/tag.ts`). Типовий `DEFAULT_TAG_PATTERN` — `#помічник`, `@помічник`, `#assistant`, `@assistant` цілим словом (не `#помічникові`, не `me@assistant.example`). Шукаємо лише в перших 4000 символах повідомлення. Модель тут не задіяна.
- **Свій шаблон** перевіряє `tagPatternProblem`: він має компілюватися, бути не довшим за 200 символів, не збігатися з порожнім рядком і звичайними («да», «ВЖЕ», «7 ЗАПИСАВ», «ok») та не мати вкладених повторень на кшталт `(a+)+`, бо шаблон виконується на сервері. Інакше — 400 `invalid_tag_pattern`. UI перевіряє те саме до збереження.
- **Хто може тегати:** `me` (типово — автор повідомлення є власником токена) або `anyone` (будь-хто в чаті).
- **Опитування.** Читаються всі чати (крім зниклих), найдавніше прочитані першими. Чат поза сайдбаром ClickUp (канал, за яким людина не стежить, схований DM) чекає на 10 хв довше (`offSidebarDelayMs`). За прохід — до 30 чатів (`channelsPerPoll`) і 60 викликів (`callsPerPoll`); прохід раз на 2 хв, тож це до 30 викликів за хвилину при ліміті ClickUp 100. Описи (люди DM, followers, шлях) беруться з викликів, що лишилися після читання чатів. Бекоф після помилок і очікування `X-RateLimit-Reset` на 429 — як були.
- **Що читається.** Нові кореневі повідомлення з курсора (до 3 сторінок по 50) і нові відповіді тредів, у яких виріс лічильник. Перше читання чату лише ставить курсор. Повідомлення без тегу (від того, кому дозволено тегати) далі не йде: не зберігається, хід не запускається, модель його не бачить. У таблицях джерела — лише курсори й id.
- **Звернення з тегу** (`SourceMessage`):
  - `text` — повідомлення без тегу, тобто інструкція («оціни це»), може бути порожнім;
  - `context` — повідомлення, на які вказує тег, від найстаріших. У треді — корінь і відповіді до тегу (до 50). У пласкому чаті — до `contextMessages` попередніх кореневих повідомлень (типово 10, 0–50); за потреби ще одна сторінка, якщо бюджет дозволяє. В обох випадках — лише після попереднього тегу;
  - `files` — вкладення тегнутого повідомлення, потім контексту від новіших, кожне один раз, до 8;
  - автори — імена учасників (невідомий — без імені).

  Ядро зберігає це одним повідомленням `source` від того, хто тегав: контекст цитатою (`> **Olena** · 2026-11-16 09:58 UTC`), далі інструкція. Агент отримує той самий текст із заголовком «X tagged you…».
- **Прив'язка.** Ключ — `clickup:<ws>:<channel>:<корінь треду>`; для тегу в кореневому повідомленні корінь — воно саме. Пізніший тег у тому самому треді додається до відкритого звернення (контекст — що з'явилося після попереднього тегу). Новий тег у пласкому чаті — нове звернення. Тег у треді закритого звернення — нове звернення з `previousRequestId`.
- **Ліміт ходів** (20 на годину) лишився: понад нього тег зберігається як звернення без розбору (`not_analysed:limit`).
- **Агент читає на запит** (`source_list_channels` / `source_read_channel`) лише чати, де людина тегала (`assistant_source_channels.tagged_at`). Інші — 404.
- **Міграція** (`ClickUpSourceStorage.retireChannelModes`, при `init`). Рядки зі старим режимом (`ignore` / `addressed` / `watch`) отримують `mode = 'retired'` і `rule = null`. Курсори каналів і тредів стають часом перемикання, тож написане раніше на тег не перевіряється, а тег після перемикання знаходиться на найближчому читанні. Повторний запуск рядки не чіпає. Колонки `mode`, `rule`, `involves_me` лишаються: схеми лише додають колонки, а `mode` — NOT NULL. Нові рядки пишуть `retired` / `null` / `false`.
- **Налаштування** зберігаються в `assistant_source_connections`: `tag_pattern` (null — типовий), `tag_who`, `tag_context`. «Відключити» їх стирає разом із підключенням; нове підключення починає з типових.
- **Маршрут:** `PUT /web/assistant/sources/clickup/tag { pattern?: string | null, who?: 'me' | 'anyone', contextMessages?: number }` (`self.write`). Помилки: 400 `invalid_tag_pattern` / `invalid_tag_who` / `invalid_tag_context` / `invalid_body`, 409 `not_connected`. `PUT …/channels/:ws/:ch` і `PUT …/dms` прибрано (404). `GET /web/assistant/sources` замість `channels` віддає `tag: { pattern, defaultPattern, who, contextMessages }` і `chats: { total, inSidebar }`.
- **UI** (Помічник › Джерела): підключення без змін (особистий токен або підключення організації), рядок «Шукаю тег у N чатах», блок «Тег» — пояснення одним реченням, поле шаблону з перевіркою, «Типовий тег», «Перевірити» (живий тестер: чи є тег і яка інструкція лишиться), «Хто може тегати», «Попередні повідомлення». Списку чатів (`SourceChannelList`) немає. У «Проактивності» лишився тільки дайджест.
- **Чого немає (свідомо).** «Читати все й вирішувати / пропонувати / робити огляди» — це автоматизація маршрутизації, поза межами зараз. Якщо з'явиться — окремою явно налаштованою автоматизацією.
- **Обмеження.** Тег у відповіді видно, лише якщо корінь треду є серед прочитаних сторінок (до 150 кореневих повідомлень з курсора), як і раніше для відповідей. Як `@помічник` виглядає в `content`, коли ClickUp перетворює його на згадку, на живих даних не перевірено: тест — «Перевірити» в налаштуваннях і діагностика.
