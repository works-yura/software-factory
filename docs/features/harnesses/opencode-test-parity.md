# OpenCode: паритет тестів із t3code

Звірка тестів OpenCode-провайдера t3code (`lab/factory/temp/t3code`, лише читання) з тестами harness OpenCode Factory. Переносили **сценарії**, не код: t3code побудовано на Effect, у нас — простий TypeScript і vitest. Рішення — [ADR-0043](../../adr/0043-opencode-harness-free-models.md), огляд — [design.md](design.md#opencode).

**Разом 256 випадків t3:** перенесено — 76, вже покрито — 11, н/з — 164, свідомо не перенесено — 5.

Один рядок — один тест t3 (`it`, `it.effect`, `it.live`, `*.each`; рядки `*.each` — у дужках). Однакові «н/з» з однією причиною зведено в рядок з усіма номерами. Статуси:

- **перенесено** — сценарій тепер перевіряє тест Factory (назва `it` у лапках); «**Виправлено**» — тест падав на нашому коді, код виправлено;
- **вже покрито** — наш наявний тест перевіряв те саме;
- **н/з** — функції в Factory немає свідомо: протокол OpenCode 2.x, цілі, fork/revert/rollback, компакція, фонові субагенти, спільний або зовнішній сервер, генерація тексту, читання входу людини (ADR-0043 забороняє), режим «дозволити все»;
- **свідомо не перенесено** — функція є, але тест не має сенсу або суперечить рішенню (причина в рядку).

## Де тести

У `packages/harness-opencode-core/src/`:

- `parity.test.ts` — перекладач подій, помилки, правила дозволів, допоміжне, каталог і використання, сценарії сесії через фейковий сервер;
- `replay.test.ts` — записані t3code потоки справжнього OpenCode 1.14.39 через сесію Factory;
- `server.test.ts` — старт `opencode serve` (порт, пароль, перевірка здоров’я, тайм-аут, ранній вихід) і проба каталогу;
- `testkit.ts` — фейковий сервер: допуск prompt (повідомлення людини й `busy`, як у справжнього), `parentID` для `GET /session/{id}`, збої маршрутів, зависання `/event` і `/provider`, чисте закриття потоку, відповідь health на вибір.

Фікстури `src/fixtures/t3code/*.ndjson` скопійовано без змін з `apps/server/src/orchestration-v2/testkit/fixtures/{simple,turn_interrupt,plan_questions,opencode_subagent,opencode_child_approval,opencode_running_child_approval}/opencode_transcript.ndjson` t3code (MIT, © 2026 T3 Tools Inc.). Інший код t3code не копіювали.

## Знайдені й виправлені помилки

1. **Запит дозволу або питання від субагента, чий виклик `task` ще не з’явився в потоці, губився, а хід висів.** Тепер власника сесії питаємо в OpenCode (`GET /session/{id}`, `parentID`, ланцюжком угору) і паркуємо хід на запиті (`session.ts` `#ownsAsk`, `events.ts` `adoptChild`).
2. **Застарілий `idle` попереднього ходу міг одразу завершити наступний хід того самого запуску** (OpenCode шле і `session.status idle`, і `session.idle`). Тепер хід приймає `idle` лише після доказу, що OpenCode узяв prompt: `busy`, свіже повідомлення людини або запит до людини (`events.ts`, `promptedAt`).
3. **Prompt, який OpenCode відхилив до запуску (невідома модель), висів до тайм-ауту ходу:** `session.error` без `busy` тепер завершує хід (перевірено на справжньому CLI: `model_unavailable` за ~0,7 с).
4. **Токени:** `step-finish`, надісланий двічі, рахувався двічі; `promptTokens` не містив читань і записів кешу, а `completionTokens` — reasoning (контракт, Claude Code і Codex рахують їх усередині).
5. **На картці дозволу для вже показаного виклику був порожній вхід** (`{}`); тепер — вхід виклику (команда, шлях).
6. **`external_directory` і `doom_loop`, дозволені раз, дозволялися на всю нитку** (через `grantedTools` і `always`), хоча ADR-0043 каже «питають завжди». Тепер відповідь — `once`, без дозволу на нитку.
7. **Інструмент без правила (плагін, MCP-сервер з `opencode.json` чекауту) OpenCode виконував без питання.** Тепер перше правило — `*: ask` (`deny` для запуску без людини), MCP-сервери Factory — `<server>_*: allow`; додано `todoread`, `codesearch` (як веб), `invalid`.
8. **Зміна налаштувань дозволів між ходами одного запуску не діяла** (сервер читає правила при старті). Тепер наступний хід іде в тій самій сесії OpenCode на сервері з новими правилами.
9. **Повідомлення помилок провайдера:** `<none>`, сторінка HTML замість тексту, облікові дані й query в URL. Тепер — заголовок сторінки зі статусом, загальна фраза, URL без секретів.
10. **Класифікація:** голі `401`/`403` у тексті (порт, число) читались як `auth`; будь-який тимчасовий 429 у статусі `retry` зупиняв хід (тепер зупиняє лише вичерпаний ліміт: безкоштовний, Go, бюджет); 5xx на `prompt_async` — `overloaded`, а не `process`.
11. **Невдала відповідь на дозвіл або питання лише писалась у лог, а хід чекав вічно.** Тепер хід закінчується з причиною; 404 (OpenCode уже скинув запит) — доставлено, і якщо OpenCode тим часом закінчив хід, запуск завершується.
12. **Старт сервера:** відповідь health 401/5xx/HTML виходила сирою помилкою без `kind`; версії `v1.20.0` і `1.14.19-beta` порівнювались хибно, сміття ставало «застарою версією». Тепер — `OpenCodeError` з `auth`/`process`, розбір версії з помилкою на несумісне.
13. **Зависання:** `/event` без заголовків відповіді й `GET /provider` у пробі каталогу чекали вічно (проба тримала б кожне читання каталогу). Тепер — тайм-аути, сервер проби зупиняється.
14. **Інше:** скасовані todo показувались виконаними; команда з ненульовим кодом виходу була успішною (у Codex — помилка); 200 без вікон від Go читався як «немає підписки»; у причину збою каталогу потрапляло тіло відповіді сервера.

## Відмінності від t3, що лишаються свідомо

- Дозволи — лише з налаштувань Factory, режиму «дозволити все» немає; `external_directory` питає завжди (t3 у readOnly його дозволяє).
- `auth.json` і база людини для обліку не читаються (ADR-0043); ліміти — вікна OpenCode Go з ключем облікового запису.
- Неоднозначний префікс MCP-інструмента віддаємо довшому серверу (t3 лишає без джерела). Сервер Factory один (`factory`), тож на практиці неоднозначності немає.
- Без типового варіанта reasoning у виборі моделі: його обирає OpenCode.

## Що лишилось (не в межах цієї роботи)

- Сиріт `opencode serve` після падіння процесу Factory ніхто не прибирає (сервери стартують `detached`). Під час перевірки один провалений real-cli тест (модель повелась інакше) лишив припаркований сервер; тест тепер звільняє сесію в `onTestFinished`.
- Немає перепідключення до `/event`: обрив потоку — помилка ходу.
- `~/.opencode/bin` (куди ставить інсталятор OpenCode) не входить у `wellKnownExecutableDirs`.
- Вкладення-зображення в prompt і в результатах MCP.

## Звірка

### Адаптер OpenCode 1.x

`packages/provider-opencode/src/server/adapter.test.ts`

| t3 (рядок) | випадків | сценарій | статус | де / чому |
|---|---|---|---|---|
| 258 | 1 | читабельні й очищені помилки сесії й ходу (×5) | перенесено | `parity.test.ts` «reads a provider failure as a person can…». **Виправлено**: `<none>`, `<title>` з HTML, облікові дані й query в URL |
| 322 | 1 | APIError 429 — ліміт використання | перенесено | `parity.test.ts` «tells limits apart…» |
| 367 | 1 | змінена політика на resume і на старті ходу | перенесено | `parity.test.ts` «starts the next turn of a run on a server with the new rules…». **Виправлено** для ходів одного запуску |
| 423 | 1 | змінена політика для наявних сесій субагентів | н/з | правила — конфіг сервера (`OPENCODE_CONFIG_CONTENT`), дочірні сесії їх успадковують |
| 529 | 1 | нормалізація токенів кроків (completed / failed / unavailable, ×3) | перенесено | `parity.test.ts` «counts each step once…», `replay.test.ts` simple. **Виправлено**: крок рахується один раз, кеш — у prompt, reasoning — у completion. Відсіювання кроків чужого повідомлення (`parentID`) не перенесено: `messageID` підказки ми не задаємо |
| 663 | 1 | multi-select і custom у живій відповіді | перенесено | `parity.test.ts` «keeps a multi-select question…»; `custom:false` н/з — у картці `AskUserQuestion` такого прапорця немає |
| 741 | 1 | життєвий цикл інструментів, види дозволів, пізній текст | перенесено | `parity.test.ts` «follows a command through its states…», «asks about reading outside the checkout…». **Виправлено**: ненульовий код виходу — помилка; `external_directory` завжди питає |
| 994 | 1 | фонова дочірня задача після кінця кореневого ходу | н/з | фонових субагентів немає |
| 1089 | 1 | вивід read і заголовки пошуку | н/з | подання: результат лишається сирим текстом, UI малює за назвою інструмента Factory |
| 1219 | 1 | скасовані todo відкидаються | перенесено | `parity.test.ts` «drops cancelled todos…». **Виправлено** (було «completed») |
| 1275 | 1 | MCP-виклики — не локальні правки | перенесено | `parity.test.ts` «names MCP calls by their server…». Неоднозначний префікс: беремо довший сервер (t3 лишає без імені). Вкладення-зображення не переносимо (транскрипт текстовий) |
| 1446, 1512 | 2 | нативні команди (`session.command`), HTTP-тайм-аут команди | н/з | слеш-команд OpenCode немає |
| 1592, 2459 | 2 | компакція; гонка компакції з кінцем потоку | н/з | компакції немає |
| 1650, 1690, 2915 | 3 | хід на треді форку, межа revert, межа форку | н/з | fork і revert немає |
| 2928 | 1 | rollback (×2) | н/з | rollback немає |
| 1778 | 1 | steer з агентом, варіантом і system | вже покрито | `session.test.ts` «runs a turn on the CLI with the picked model…», `parity.test.ts` «sends each turn the model and variant…» (steer — це зупинка й новий хід тим самим шляхом) |
| 1834 | 1 | новий prompt живий попри застарілий idle і запізнілий busy | перенесено | `parity.test.ts` «does not let the last turn’s idle end the next turn of the run». **Виправлено** (допуск ходу) |
| 2584, 2599 | 2 | допуск: idle до повідомлення людини; допуск за завершенням асистента | перенесено | `parity.test.ts` «holds an idle that comes before OpenCode took the prompt» |
| 2613, 2629, 2645 | 3 | скидання допуску перед abort; тимчасовий збій статусу; запізніла відповідь статусу | н/з | `session.status` не опитуємо; зупинка завершує хід напряму |
| 2154 | 1 | steer відхилено, коли stop виграв витяг тексту з вкладення | н/з | вкладень немає |
| 2245 | 1 | зупинка першого prompt, поки запит у дорозі | перенесено | `parity.test.ts` «sends nothing for a turn stopped while its server starts», `replay.test.ts` turn_interrupt |
| 2413 | 1 | потік подій закрився чисто — хід падає | перенесено | `parity.test.ts` «fails the turn when the event stream ends cleanly mid-turn» |
| 2523 | 1 | не реєструвати хід після кінця потоку | вже покрито | кожен запуск відкриває власний сервер і потік; закритий потік — помилка ходу (`parity.test.ts`, рядок вище) |
| 2665 | 1 | обмежені діагностики протоколу в логах | н/з | журналу протоколу немає |
| 2705 | 1 | прийняття переданої ідентичності треду | н/з | тред між адаптерами не передається (handoff — текстом) |
| 2809 | 1 | режими → безпечні правила дозволів | перенесено | `parity.test.ts` «asks about a tool no rule names, first…». **Виправлено**: правило `*: ask` (невідомий інструмент OpenCode дозволяв мовчки) |
| 2846 | 1 | неінтерактивна пісочниця через правила | перенесено | `parity.test.ts` «refuses everything that would ask when nobody can answer…». t3 у readOnly дозволяє `external_directory`; у нас за ADR-0043 воно завжди питає або відмовляє |
| 2885 | 1 | захист від рекурсії в дочірніх сесіях task | н/з | правил сесій не змінюємо; власне `task: deny` OpenCode для дитини лишається |
| 2995 | 1 | автентифікована сесія (керований / зовнішній сервер, ×2) | перенесено | `server.test.ts` «starts on a loopback port of its own…»; зовнішній сервер — н/з |

### Записані потоки OpenCode (replay)

`apps/server/src/orchestration-v2/testkit/OpenCodeReplayFixtures.integration.test.ts + fixtures/`

| t3 (рядок) | випадків | сценарій | статус | де / чому |
|---|---|---|---|---|
| simple | 1 | текстова відповідь (1.14.39) | перенесено | `replay.test.ts` simple |
| turn_interrupt | 1 | зупинка одразу після prompt | перенесено | `replay.test.ts` turn_interrupt |
| plan_questions | 1 | питання з варіантами | перенесено | `replay.test.ts` plan_questions |
| opencode_subagent | 1 | делегування `task` | перенесено | `replay.test.ts` subagent |
| opencode_child_approval | 1 | дозвіл дитини до появи виклику task | перенесено | `replay.test.ts` child_approval. **Виправлено**: власника запиту з’ясовуємо через `GET /session/{id}` (`parentID`); раніше запит губився, а хід висів |
| opencode_running_child_approval | 1 | дозвіл дитини, що вже працює | перенесено | `replay.test.ts` running_child_approval. **Виправлено**: на картці дозволу — вхід виклику (раніше `{}`) |
| opencode2_* (16 фікстур) | 16 | background, command, compaction, fork, inbox, interrupt, missing_step_usage, nested_background, permission, question, resume_after_restart, revert, simple, skill, subagent, tool_call | н/з | протокол OpenCode 2.x не підтримуємо |
| 32 | 1 | фікстури зі «стартом виконання, який збірка не декодує» (×2) | н/з | конверти OpenCode 2 |

### Драйвер

`packages/provider-opencode/src/server/driver.test.ts`

| t3 (рядок) | випадків | сценарій | статус | де / чому |
|---|---|---|---|---|
| 84 | 1 | моделі через обгортку з шляхом відносно home | н/з | CLI шукає `@factory/harness/executable`; запуск — масив аргументів без shell |
| 175, 190, 213, 823 | 4 | OpenCode 2 / mise-shim / сканування робочої теки / оновлення на місці | н/з | OpenCode 2.x і сканування робочої теки не підтримуємо |
| 225, 261 | 2 | підтримка цілей за версією (×5) і після оновлення | н/з | цілей немає |
| 336 | 1 | читання можливостей не чекає недосяжного сервера | перенесено | `server.test.ts` «gives up a server that never lists its providers…». **Виправлено**: тайм-аут `GET /provider` у пробі |
| 350 | 1 | відновлення каталогу після probe / error / empty (×3) | перенесено | `parity.test.ts` «retries a failed or empty catalog soon…» |
| 482 | 1 | не повторювати відхилений пароль сервера | н/з | пароль генеруємо самі на кожен запуск |
| 514 | 1 | відновлення використання Go без перезапуску (×5) | н/з | фонового опитування немає; вікна читаються на запит |
| 709, 791 | 2 | самооновлення CLI | н/з | CLI не оновлюємо (`OPENCODE_DISABLE_AUTOUPDATE`) |

### Статус провайдера

`packages/provider-opencode/src/server/status.test.ts`

| t3 (рядок) | випадків | сценарій | статус | де / чому |
|---|---|---|---|---|
| 40 | 1 | ліміти Go з XDG-ключа, час скидання, 125 % обрізано | перенесено | `parity.test.ts` «clamps Go windows…»; читання ключа з auth.json — н/з (ADR-0043) |
| 100, 231 | 2 | вибір ключа консолі / auth.json | н/з | дані входу людини не читаємо (ADR-0043) |
| 300 | 1 | без локальних облікових даних для зовнішнього інстансу | н/з | зовнішнього сервера й локальних ключів немає |
| 324 | 1 | відсутність Go ≠ зламана відповідь | перенесено | `parity.test.ts` «tells a broken usage answer from a key without Go». **Виправлено**: 200 без вікон — `failed`, не `unsupported` |
| 528 | 1 | збої виявлення — без пароля в логах (×5) | перенесено | `server.test.ts` «says what is wrong with …, and never shows the password» |
| 605 | 1 | порожній каталог лишається повторюваним | перенесено | `parity.test.ts` «retries a failed or empty catalog soon…» |
| 632 | 1 | типовий варіант reasoning для вибору | свідомо не перенесено | рішення дизайну: без вибору варіанта OpenCode бере свій |
| 687 | 1 | навички в знімку провайдера | н/з | інвентаря навичок / команд немає |
| 754 | 1 | оновлений CLI без перезапуску позиченого сервера | н/з | спільного сервера немає |
| 788 | 1 | моделі OpenCode 2 лише в повному доступі | н/з | OpenCode 2.x і режиму «дозволити все» немає |
| 835 | 1 | старі релізи й застарілі моделі | вже покрито | `units.test.ts` «offers OpenCode's free models alone…» (застарілі відкидаються); «legacy» сімейств — н/з |
| 901 | 1 | збій списку моделей — без відповіді сервера | перенесено | `parity.test.ts` «retries a failed or empty catalog…». **Виправлено**: тіло відповіді не потрапляє в причину |
| 926 | 1 | збій інвентаря — не «порожньо» | перенесено | `parity.test.ts` «retries a failed or empty catalog…» |
| 946, 988, 1014, 1069 | 4 | зовнішній сервер з паролем, маршрутизація 2.x, повторне сканування 2.x | н/з | зовнішнього сервера й OpenCode 2.x немає |
| 973 | 1 | ECONNREFUSED на портах 401/403 лишається повторюваним (×4) | перенесено | `parity.test.ts` «does not read a port or a count of 401/403 as a refused key». **Виправлено**: голі 401/403 у тексті більше не «auth» |
| 1031 | 1 | непідтримуваний сервер відхиляється до інвентаря | перенесено | `server.test.ts` «… a version too old …» |

### Генерація тексту

`packages/provider-opencode/src/server/textGeneration.test.ts`

| t3 (рядок) | випадків | сценарій | статус | де / чому |
|---|---|---|---|---|
| 253 | 1 | скасування створення сесії до prompt | перенесено | `parity.test.ts` «sends nothing for a turn stopped while its server starts» |
| 291, 349, 431, 537 | 4 | спільний сервер, заголовки, порожній вивід, JSON як текст | н/з | генерації тексту через OpenCode немає |
| 388 | 1 | prompt, що не завершується, — abort сесії | перенесено | `parity.test.ts` «gives up a turn that never ends, and tells OpenCode to stop it» |
| 416 | 1 | пароль лише з оточення для свого сервера | перенесено | `server.test.ts` «starts on a loopback port of its own…» (заголовок Basic) |
| 461 | 1 | помилки prompt: фіксовані деталі, текст провайдера в cause | вже покрито | `units.test.ts` «tells a missing model…», «reads the message out of a response body» (текст провайдера показуємо свідомо) |
| 522 | 1 | видалити сесію, коли prompt відхилено | н/з | сесії зберігаємо для продовження |
| 571, 601 | 2 | налаштований зовнішній сервер | н/з | зовнішнього сервера немає |
| 583 | 1 | без сесії на непідтримуваній версії | перенесено | `server.test.ts` «… a version too old …» (сесій не створено) |

### Облік використання з бази OpenCode

`packages/provider-opencode/src/server/usage.test.ts`

| t3 (рядок) | випадків | сценарій | статус | де / чому |
|---|---|---|---|---|
| 22, 116, 167, 218, 273, 317, 373 | 7 | читання історії повідомлень OpenCode (SQLite, legacy JSON, WAL, symlink, корені XDG) | н/з | використання з бази OpenCode не рахуємо: токени — з подій ходу, ліміти — з вікон Go |

### Реєстр серверів

`packages/provider-opencode/src/server/OpenCodeServerLedger.test.ts`

| t3 (рядок) | випадків | сценарій | статус | де / чому |
|---|---|---|---|---|
| 132, 176, 195, 214 | 4 | зачистка сиріт після падіння, перевикористаний pid, інший порт, чужий сервер | н/з | реєстру серверів немає (див. «Що лишилось») |
| 150 | 1 | група, чия обгортка вже вийшла | свідомо не перенесено | потрібне справжнє дерево процесів; `terminate()` шле сигнал групі (`-pid`), залишків після real-cli немає |
| 234 | 1 | зупинка групи, перерваної під час старту | перенесено | `server.test.ts` «gives up a start that never says where it listens…», «says why a server exited before it was ready…» |

### Власник сервера

`packages/provider-opencode/src/server/OpenCodeServerOwner.test.ts`

| t3 (рядок) | випадків | сценарій | статус | де / чому |
|---|---|---|---|---|
| 60, 88, 111 | 3 | спільні позичальники з TTL, повтор старту, заміна мертвого процесу | н/з | спільного довгоживучого сервера немає: один на запуск |
| 158 | 1 | перерваний старт прибрано, повтор можливий | перенесено | `server.test.ts` «gives up a start that never says where it listens, stops it, and starts again after» |

### Проба версії

`packages/provider-opencode/src/server/versionProbe.test.ts`

| t3 (рядок) | випадків | сценарій | статус | де / чому |
|---|---|---|---|---|
| 31 | 1 | класифікація виводу `--version` | перенесено | `parity.test.ts` «reads versions as OpenCode prints them…». **Виправлено**: `v`-префікс, pre-release старший за реліз — ні, сміття — помилка |
| 43, 163 | 2 | 2.x на /api/info; кеш проби 2.x | н/з | OpenCode 2.x не підтримуємо |
| 56 | 1 | HTML замість JSON | перенесено | `server.test.ts` «… the web UI’s HTML …». **Виправлено**: був сирий SyntaxError |
| 69 | 1 | префікс шляху й query в URL сервера | н/з | адреса завжди `http://127.0.0.1:<порт>` |
| 91 | 1 | відхилений пароль, а не «версія» | перенесено | `server.test.ts` «… a refused password …». **Виправлено**: був сирий `OpenCodeHttpError` без `kind` |
| 104 | 1 | не-ASCII пароль як UTF-8 | перенесено | `parity.test.ts` «sends a non-ASCII password as UTF-8 Basic auth» |
| 120 | 1 | інший JSON — не OpenCode | перенесено | `server.test.ts` «… JSON that is not a health answer …» |
| 134 | 1 | без URL і облікових даних у деталях помилки | перенесено | `server.test.ts` (пароль не показується в жодній помилці старту) |

### Каталог OpenCode 2

`packages/provider-opencode/src/server/openCode2Catalog.test.ts`

| t3 (рядок) | випадків | сценарій | статус | де / чому |
|---|---|---|---|---|
| 56, 73, 88 | 3 | імена провайдерів моделей /api/model | н/з | OpenCode 2.x |

### Runtime: інвентар, оточення, парсери, дозволи

`packages/provider-opencode/src/server/OpenCodeRuntime.*.test.ts`

| t3 (рядок) | випадків | сценарій | статус | де / чому |
|---|---|---|---|---|
| inventory:20 | 1 | abort запитів, коли завантаження інвентаря перервано | перенесено | `server.test.ts` «gives up a server that never lists its providers, and stops it». **Виправлено** |
| inventory:59, 111 | 2 | команди теки; агенти не завадили провайдерам | н/з | інвентаря команд / агентів немає |
| environment:9 | 1 | пароль з налаштувань важливіший за оточення | н/з | пароль у налаштуваннях не задається |
| environment:22 | 1 | успадкований пароль не йде на зовнішній сервер | перенесено | `parity.test.ts` «gives the server only its own password…» |
| environment:43 | 1 | сервер нижче підтримуваної версії | перенесено | `server.test.ts` «… a version too old …» |
| cliParsers:16, 43 | 2 | файли як частини prompt; вставлений текст | н/з | лише текстові частини (вкладення — у беклозі ADR-0043) |
| permissions:8 | 1 | accept / acceptForSession / decline → once / always / reject (×3) | вже покрито | `session.test.ts` «parks on a permission ask…» (always, reject); `once` — `parity.test.ts` «never lets an Allow of reading outside the checkout cover the next such read» |

### Елементи інструментів

`packages/provider-opencode/src/server/toolItems.test.ts`

| t3 (рядок) | випадків | сценарій | статус | де / чому |
|---|---|---|---|---|
| 13 | 1 | зображення у виводі інструмента | н/з | результати інструментів — текст |
| 48 | 1 | точний вміст файлів: видалення, пробіли, порожній запис (×3) | перенесено | `parity.test.ts` «keeps file content exactly…» |

### Адаптер OpenCode 2 (orchestration v2)

`apps/server/src/orchestration-v2/Adapters/OpenCode2AdapterV2.test.ts`

| t3 (рядок) | випадків | сценарій | статус | де / чому |
|---|---|---|---|---|
| 450 | 1 | модель і варіант змінюються перед ходом | перенесено | `parity.test.ts` «sends each turn the model and variant picked for it» |
| 479 | 1 | перейменування сесії за назвою треду | н/з | синхронізації назв немає |
| 508 | 1 | хід закінчується на своєму треді | свідомо не перенесено | `thread.switch` під час запуску кидає помилку; низька цінність |
| 526 | 1 | класифікація квоти / ліміту / збою (×3) | вже покрито | `units.test.ts` «reads the free allowance running out…», «tells a missing model…» |
| 555 | 1 | варіанти квот (×6) | перенесено | `parity.test.ts` «tells limits apart…»; рядок про ліміт сесії Claude без статусу — н/з (входимо лише в облікові записи OpenCode) |
| 635 | 1 | тижневий ліміт Claude з часом скидання | н/з | час скидання — з вікон облікового запису |
| 663, 2171 | 2 | недекодований термінальний конверт; форма, яку не показати | н/з | конверти й форми OpenCode 2 |
| 676 | 1 | хід живе попри недекодований старт | перенесено | `parity.test.ts` «skips events it cannot read, and goes on with the turn» |
| 730 | 1 | зупинка ходів на зовнішньому сервері | н/з | зовнішнього сервера немає |
| 747 | 1 | нічого не надсилати для ходу, зупиненого під час підготовки | перенесено | `parity.test.ts` «sends nothing for a turn stopped while its server starts» |
| 887, 907, 930, 978, 1174, 1197, 1238, 1262, 1413, 1476, 1558, 1595, 1743, 1961, 4837, 5025, 5113, 5214, 5322 | 19 | фонові субагенти, пробудження, продовження | н/з | фонових субагентів і продовжень немає |
| 1665 | 1 | пізній кінець зупинки не завершує наступний хід | вже покрито | `parity.test.ts` «does not let the last turn’s idle end the next turn of the run»; steer = новий запуск з власним сервером і потоком |
| 1690 | 1 | перевірка сервера після збою prompt | перенесено | `parity.test.ts` «keeps a refused prompt’s message for the next run…». **Виправлено**: 5xx — `overloaded` (повторюваний), а не `process` |
| 1713 | 1 | перевірка спільного сервера, коли prompt стартував пізно | н/з | спільного сервера немає |
| 1965 | 1 | хід зупинено, хоч запит Stop не вдався | перенесено | `parity.test.ts` «stops a turn even when OpenCode’s abort fails» |
| 1987, 3112, 3166, 3228 | 4 | правила при resume; реєстрація MCP на кожен хід; імена MCP-серверів | н/з | правила й MCP — конфіг при старті сервера, ім’я сервера фіксоване (`factory`) |
| 2014 | 1 | перенесення сесії при зміні worktree | н/з | переносу worktree немає |
| 2034 | 1 | сесію видалено ззовні | вже покрито | `session.test.ts` «goes on in the same OpenCode session … starts afresh with the history when it is gone» |
| 2058 | 1 | перезапущений хост: відповісти на загублений запит | перенесено | `parity.test.ts` «answers an ask a restarted server lost as the next turn» |
| 2099 | 1 | відповідь неможливо доставити — хід закінчується | перенесено | `parity.test.ts` «ends the turn when OpenCode does not take an answer». **Виправлено**: раніше лише попередження в лог, хід висів |
| 2138 | 1 | відповідь на вже скинутий запит — доставлено | перенесено | `parity.test.ts` «counts an answer to an ask OpenCode already dropped…». **Виправлено**: idle під час паркування губився, хід висів |
| 2209 | 1 | дозвіл субагента — на ході батька | перенесено | `replay.test.ts` child_approval, running_child_approval |
| 2255 | 1 | «дозволити на сесію» — у правилах сесії | вже покрито | `session.test.ts` «parks on a permission ask…» (у нас — `always` OpenCode + `grantedTools` нитки) |
| 2293, 2627, 2663 | 3 | перечитування агентів; `$skill` після сканування | н/з | інвентаря агентів / навичок OpenCode 2 немає (навичка — конверт `<skill>`) |
| 2389, 2473, 2732, 2775, 2803, 3019, 3758 | 7 | стан після перепідключення потоку | н/з | перепідключення немає (див. 2519) |
| 2519, 2697 | 2 | хід завершився / триває, поки потік лежав | свідомо не перенесено | перепідключення потоку немає: сервер свій на запуск, на loopback; обрив потоку — помилка ходу |
| 2564 | 1 | команда робочої теки після обриву потоку | н/з | слеш-команд немає |
| 2831 | 1 | життєвий цикл MCP-інструментів (×3) | перенесено | `parity.test.ts` «names MCP calls by their server…»; вкладення-зображення не переносимо |
| 2894 | 1 | оновлення todo в один список | перенесено | `parity.test.ts` «drops cancelled todos…». **Виправлено** |
| 3062 | 1 | команда з ненульовим кодом — невдала | перенесено | `parity.test.ts` «follows a command through its states…». **Виправлено** |
| 3246, 3362 | 2 | зображення як файли prompt; steer під час вкладень | н/з | лише текстові частини prompt |
| 3531 | 1 | текст зі списку повідомлень сесії | н/з | знімка через API немає; імпорт власної бази — `local-sessions.test.ts` |
| 3555, 3910 | 2 | список моделей на кожен хід; ліміт моделі на теку | н/з | каталог не читається на хід і не залежить від теки |
| 3583 | 1 | використання сумується за кроками | перенесено | `parity.test.ts` «counts each step once…» |
| 3617 | 1 | запис кешу — як створення кешу, у prompt | перенесено | `parity.test.ts` «counts each step once…», `replay.test.ts` simple. **Виправлено**: `promptTokens` не містив кешу (і `units.test.ts` стверджував хибне значення) |
| 3713 | 1 | повтор після 429 відновлюється; Stop під час повтору (×2) | перенесено | `parity.test.ts` «keeps retrying a rate limit per minute…». **Виправлено**: будь-який тимчасовий 429 зупиняв хід |
| 3827 | 1 | повтор замінено помилкою, що завалила хід | перенесено | `parity.test.ts` «keeps retrying a rate limit per minute…» (`session.error` 429 → `rate_limit`) |
| 3969, 4019, 4087, 4311, 4470, 4539, 4590, 4674, 4696, 4802 | 10 | rollback, revert, fork | н/з | rollback / revert / fork немає |
| 4154, 4248 | 2 | унікальні id на спільному сервері; статус спільної сесії | н/з | спільного сервера немає |
| 4381 | 1 | повернення застряглого steer | н/з | inbox OpenCode 2 |
| 5422, 5468, 5502, 5590, 5635, 5678, 5744, 5814 | 8 | цілі (`/goal`) | н/з | цілей немає |

### Оркестратор OpenCode 2 (інтеграція)

`apps/server/src/orchestration-v2/OpenCode2OrchestratorV2.integration.test.ts`

| t3 (рядок) | випадків | сценарій | статус | де / чому |
|---|---|---|---|---|
| 298 | 1 | зміна моделі перед наступним prompt (×2) | перенесено | `parity.test.ts` «sends each turn the model and variant picked for it» |
| 352 | 1 | правила переписуються при зміні режиму між ходами | перенесено | `parity.test.ts` «starts the next turn of a run on a server with the new rules…». **Виправлено** |
| 403 | 1 | план-режим забороняє правки, після — знято | вже покрито | `session.test.ts` «plans with the read-only plan agent and parks on the plan» |
| 445 | 1 | форк з попереднього ходу | н/з | форку немає |
| 514 | 1 | скасоване повідомлення черги не надсилається | н/з | скасування follow-up у черзі немає |
| 656, 751, 852 | 3 | фонові звіти й потік, що обірвався | н/з | фонових субагентів і перепідключення немає |

### Інші тести OpenCode 2

`OpenCode2PendingSnapshots.evidence / OpenCode2Client.events / v2/OpenCode2Client / v2/OpenCode2Server`

| t3 (рядок) | випадків | сценарій | статус | де / чому |
|---|---|---|---|---|
| PendingSnapshots:153 | 1 | знімки незавершеної роботи (×6) | н/з | фонова робота й фікстури OpenCode 2 |
| Client.events:34 | 1 | недекодовані старти лишаються, невідомі події пропущено | перенесено | `parity.test.ts` «skips events it cannot read…» |
| Client:46 | 1 | не-ASCII пароль як UTF-8 | перенесено | `parity.test.ts` «sends a non-ASCII password as UTF-8 Basic auth» |
| Client:56 | 1 | підписка без заголовків відповіді — тайм-аут | перенесено | `parity.test.ts` «fails the run, instead of hanging, when the server never opens its event stream». **Виправлено** |
| Client:128, 157 | 2 | формати компакції (×8) | н/з | компакції немає |
| Server:55, 69 | 2 | 401 (і з порожнім тілом) — відхилений пароль | перенесено | `server.test.ts` «… a refused password …». **Виправлено** |
| Server:76 | 1 | 500/502 — помилка сервера, а не «недосяжний» | перенесено | `server.test.ts` «… a server error …». **Виправлено** |
| Server:87 | 1 | HTML веб-UI — не сервер OpenCode | перенесено | `server.test.ts` «… the web UI’s HTML …». **Виправлено** |
| Server:119 | 1 | деталі помилок без URL сервера | перенесено | `server.test.ts` (пароль у помилках старту не з’являється) |
| Server:153 | 1 | запущений сервер отримує лише свій пароль | перенесено | `parity.test.ts` «gives the server only its own password…» |
| Server:181 | 1 | готовий, коли /api/info приймає згенерований пароль | вже покрито | `real-cli.integration.test.ts` (справжній CLI перевіряє пароль), `server.test.ts` «starts on a loopback port…» |

