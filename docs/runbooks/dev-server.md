# Дев-сервер

## Запуск

```sh
cd apps/server
corepack pnpm dev:local
```

- Вхід через Google (`FACTORY_AUTH=google`; `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `FACTORY_AUTH_SECRET` у `apps/server/.env`, див. README).
- CLI агентів (`claude`, `codex`) сервер знаходить сам (ADR-0038): `FACTORY_CLAUDE_CODE_COMMAND` / `FACTORY_CODEX_COMMAND`, якщо задано (тоді лише цей шлях), інакше `PATH`, далі `~/.local/bin`, `~/.claude/local`, bin node сервера і `NVM_BIN`, `/opt/homebrew/bin`, `/usr/local/bin`. На старті в лозі — `[factory] Claude Code: <шлях> (<звідки>, <версія>).` або `… not found (looked in …)`; те саме — у Settings › Налагодження (`/web/config/versions`). Без CLI харнес недоступний з причиною («Claude Code не встановлено на цьому сервері»), а запуск картки падає одразу з `harness_not_configured`, без повторів; встановлений пізніше CLI підхоплюється без перезапуску, невдале рішення — «Повторити».
- Порт `5874` (API — `http://127.0.0.1:5874/api`). Перевірка: `curl -s -o /dev/null -w '%{http_code}' http://localhost:5874/auth/me` → `200` (решта шляхів без входу — `401` або перенаправлення на `/signin`).
- Під час старту `sync:skills` копіює `packages/harness-mastra/factory-skills` у `apps/server/src/mastra/public/factory-skills`.
- Сервер стежить за файлами й сам перезапускається після зміни коду пакетів (`Restarting server...` у лозі).

## Що після якої зміни

| Змінено | Потрібно |
| --- | --- |
| UI (`apps/ui`, `packages/playground-ui`) | `cd apps/ui && corepack pnpm -s build`, потім оновити сторінку: сервер віддає `apps/ui/dist` |
| Скіли (`factory-skills`) | повний перезапуск сервера: скіли копіюються лише під час старту |
| Код пакетів сервера | нічого: перезапуститься сам; нова колонка БД додається під час старту |

## Повний перезапуск

1. Знайти процес: повідомлення «Another development server instance is already running in this directory» називає PID (`kill <pid>`), або `lsof -nP -iTCP:5874 -sTCP:LISTEN`.
2. Зупинити **за PID**: `kill <pid>`; дочекатися, поки процес зникне (`kill -0 <pid>`).
3. Запустити знову (`corepack pnpm dev:local`) і перевірити `200` на `/auth/me`.

На Mac mini сервер тримає launchd — там перезапуск інакший (див. нижче).

Процес може тримати блокування, навіть коли порт уже не відповідає — тоді теж зупинити за PID. Сервер часто перезапускають інші сесії: перед зупинкою подивитись, чий він і чи не йде e2e.

## Mac mini: сервер піднімається сам (launchd + Tailscale)

На Mac mini (`Mac-mini-Yura`, у Tailscale — `hab`) сервер Factory працює постійно й сам піднімається після перезавантаження. Скрипти — у репозиторії, `scripts/mac-mini/`; встановлення (і оновлення після зміни скриптів):

```sh
scripts/mac-mini/install.sh https://factory.tail5c61c7.ts.net
```

`install.sh` копіює `start-server.sh` у `~/.mastracode/factory-v4/` (поза проєктом: диск `/Volumes/dot` монтується пізніше за вхід), пише там `server.env` (`FACTORY_REPO`, `MASTRACODE_PUBLIC_URL`, `PORT`), розгортає шаблон plist у `~/Library/LaunchAgents/` і перезавантажує агент. Решта налаштована поза репозиторієм:

### Викатка: сервер працює з викоченого коміту, не з робочої папки

**Правки в робочій папці (`v4/`) на сервер Mac mini не потрапляють**, навіть збережені й закомічені. Сервер працює з окремої папки проду `/Volumes/dot/Project/factory` — версії (релізи) — git worktree цього репозиторію в `releases/<дата_час>-<коміт>`, наприклад `releases/2026-11-13_2310-d31aa47e`, посилання `current` — на ту, що працює, бо дев-сервер у робочій папці перезапускався від кожного збереженого файлу, недописаного теж. Папку задає `FACTORY_RUNTIME` у `~/.mastracode/factory-v4/server.env` (без нього — `../v4-runtime` поруч із репозиторієм); кожна викатка записує в `server.env` `FACTORY_REPO=<папка>/current`, звідки автозапуск і стартує. Руками в папці проду нічого не правити. Викотити:

```sh
scripts/mac-mini/deploy.sh            # поточний HEAD (лише закомічене)
scripts/mac-mini/deploy.sh <коміт>    # будь-який коміт
scripts/mac-mini/deploy.sh --rollback # назад на попередню версію, без збірки (секунди)
scripts/mac-mini/deploy.sh --status   # які версії є і яка працює
```

Один деплой за раз: другий запуск відмовляється й каже, хто деплоїть і де дивитись (`<папка проду>/.deploy.lock`; блокування померлого процесу наступний деплой забирає сам). Вивід кожного деплою — `~/Library/Logs/factory-deploy.log` (`tail -f`, без рядків прогресу pnpm), початок і результат кожного — рядок у `<папка проду>/deploys.log` (`--status` показує останні). Після перезапуску деплой чекає рядка сторожа `healthy after` (до 5 хв, `FACTORY_DEPLOY_HEALTH_SECONDS`); не дочекався — завершується з помилкою й підказкою `--rollback`, сам не відкочує.

`deploy.sh` створює нову версію `releases/<дата_час>-<коміт>` на коміті, робить `pnpm install`, збірку UI і production-збірку сервера (`pnpm build` → `apps/server/.mastra/output`, ~2 хв; `mastra build` сам ставить залежності бандла в `.mastra/output/node_modules`); лише якщо все вдалося — перемикає `current`, встановлює `start-server.sh` цієї версії в `~/.mastracode/factory-v4/` і перезапускає агент. Зберігаються дві версії: нова і та, що працювала перед нею (`FACTORY_KEEP_RELEASES`); старіші переносяться в `.trash` і видаляються у фоні. Збірка впала — недозібрана версія видаляється, сервер лишається на старому коміті. `.env` у версіях — посилання на `v4/apps/server/.env` (секрети в одному місці). `apps/ui` у робочій папці для сервера збирати більше не треба.

### Режим: production-збірка (`start:local`), на тих самих даних (ADR-0040)

Сервер працює не як дев-сервер, а зі збірки: `corepack pnpm start:local` в `apps/server` = `NODE_ENV=production`, `mastra start` на `.mastra/output` версії. Без стеження за файлами й без збірки на старті: здоровий за ~6 с (дев — 30–60 с), ~0,7 ГБ пам'яті (дев — ~1,1 ГБ).

**Дані ті самі, що в `dev:local`, нічого не копіюється:** `MASTRA_DB_PATH` = `~/.mastracode/factory-v4/mastra.db` (поруч `mastra-vectors.db`, `factory-attachments`, `factory-device`), ключ облікових даних `~/.mastracode/factory-local-dev-key`, сесії харнесів `~/.mastracode/web/{claude-code,codex}-sessions`, `.env` версії (посилання на `v4/apps/server/.env`: `MASTRACODE_LOCAL_SANDBOX_ROOT=/Volumes/dot/factory-sandboxes`, шаблон — `…/.factory-template`), `FACTORY_AUTH=google`, `HOST`, `PORT=5874`, `MASTRACODE_PUBLIC_URL` з `server.env`, UI з `apps/ui/dist` версії. `start:local` ставить ті самі змінні, що `dev:local`, плюс `NODE_ENV=production`, `FACTORY_OWN_MACHINE=1` (production на власній машині: libSQL без `DATABASE_URL`, ключ машини, вхід Claude/ChatGPT, пристрої) і `FACTORY_SANDBOX_PROVIDER=local`.

- **Перед першим production-стартом** `deploy.sh` один раз робить копію БД: `~/.mastracode/factory-v4/backup-<дата>-before-prod-mode.db` (`sqlite3 .backup`, перевірка `quick_check`). Не вдалося — викатка зупиняється, сервер не чіпається.
- **Повернутись до дев-режиму** (одна змінна): дописати `FACTORY_SERVER_MODE=dev` у `~/.mastracode/factory-v4/server.env` і `launchctl kickstart -k gui/$UID/ai.eclipt.factory`; прибрати рядок — знову production (`dev:local` стирає `.mastra/output` версії, тож після нього спершу `deploy.sh`). Версія без збірки сам падає на `dev:local` (рядок `no production build … falling back to dev:local` у лозі).
- Який режим зараз: `scripts/mac-mini/deploy.sh --status` (`last start: … starting start:local`) або `grep 'starting ' ~/Library/Logs/factory.log | tail -1`.
- Відмінності production, які лишаються: логер Mastra — лише `WARN` і вище (журнали `[factory]` як і були); реєстр моделей — вбудований у `@mastra/core`, без щогодинного оновлення з мережі; better-auth обмежує частоту запитів входу; помилки API без стеку; немає `/swagger-ui`. Деталі — ADR-0040.
- Сервер слухає всі інтерфейси (`*:5874`), як і дев-сервер: `HOST` бачить лише `mastra dev`, сам сервер читає `MASTRA_HOST`.

| Що | Де |
| --- | --- |
| Адреса | `https://factory.tail5c61c7.ts.net` — лише в tailnet; Tailscale Service `svc:factory` (машина з тегом `tag:server`), проксі на `http://127.0.0.1:5874` |
| Автозапуск сервера | LaunchAgent `ai.eclipt.factory` (шаблон `scripts/mac-mini/ai.eclipt.factory.plist`): `RunAtLoad`, `KeepAlive` лише при невдалому виході, `ThrottleInterval` 30 с |
| Скрипт запуску | `scripts/mac-mini/start-server.sh` (встановлює `deploy.sh` з версії або `install.sh`): node з `nvm` (`default`), чекає `.env` викоченої версії (диск монтується пізно, до 5 хв), читає `server.env` (`FACTORY_REPO` = `/Volumes/dot/Project/factory/current`, його оновлює `deploy.sh`; `FACTORY_SERVER_MODE`) і запускає в `apps/server` `corepack pnpm start:local` (або `dev:local` у дев-режимі) |
| Сторож | той самий скрипт: кожні 20 с `GET http://127.0.0.1:5874/health` (відповідає без входу); 3 невдачі поспіль (1 хв; у дев-режимі 6 — 2 хв) — зупиняє групу процесів і всіх нащадків (varlock запускає сервер в окремій групі) і виходить з 1, launchd піднімає знову. Потрібен, бо завислий сервер не виходить сам (а `mastra dev` живе далі, коли сервер у ньому впав). Старт до першої здорової відповіді — до 3 хв (у дев-режимі до 15 хв). Рядки `[watchdog …]` у лозі |
| CLI агентів | `claude` — у `~/.local/bin`, `codex` — з node nvm. launchd дає голий `PATH` (`/usr/bin:/bin:/usr/sbin:/sbin`); сервер однаково знаходить їх сам (ADR-0038), а `start-server.sh` ще й дописує ці теки в `PATH`. Перевірити: `grep -E 'Claude Code:|Codex:' ~/Library/Logs/factory.log` або Settings › Налагодження. Закріпити конкретний бінарник — `FACTORY_CLAUDE_CODE_COMMAND` / `FACTORY_CODEX_COMMAND` (абсолютний шлях) у `apps/server/.env` |
| Лог | `~/Library/Logs/factory.log` |
| Tailscale | Login Items (System Settings › General › Login Items); serve-конфіг сервісу зберігається між перезавантаженнями |
| Google sign-in | клієнт OAuth у Google Console: origin `https://factory.tail5c61c7.ts.net`, redirect URI `https://factory.tail5c61c7.ts.net/auth/api/callback/google` |

### Вебхуки ззовні (Tailscale Funnel)

Сервіс `svc:factory` видно лише в tailnet; GitLab і інші зовнішні сервіси туди не дістануться, а Funnel для сервісів Tailscale не підтримує. Тому назовні відкрито **лише шляхи вебхуків** на імені машини, кожен сервер — під своїм префіксом (`/factory/…`), публічно лише порт 443:

| Публічна адреса | Куди | Секрет |
| --- | --- | --- |
| `https://hab.tail5c61c7.ts.net/factory/gitlab` | `http://127.0.0.1:5874/web/gitlab/webhook` | `GITLAB_WEBHOOK_SECRET` → поле Secret token вебхука в GitLab |
| `https://hab.tail5c61c7.ts.net/factory/github` | `http://127.0.0.1:5874/web/github/webhook` | `GITHUB_APP_WEBHOOK_SECRET` → Webhook secret GitHub App |

Усе інше на цьому імені (`/`, `/factory`, `/api`, `/web/…`) — 404; UI і API назовні не видно. Обробник відкидає запит без правильного `X-Gitlab-Token` (401). **Сервіс і шляхи Funnel застосовує сам `start-server.sh` при кожному старті** (`ensure_tailscale`): список — у `server.env`, `TS_SERVICE` і `FUNNEL_ROUTES` (`"<публічний шлях>=<шлях сервера> …"`). Новий шлях — додати в `FUNNEL_ROUTES` і `launchctl kickstart -k gui/$UID/ai.eclipt.factory`; руками `tailscale funnel` не запускати. Не застосувалось (Funnel не дозволено машині, сервіс чекає підтвердження) — рядок `[watchdog …] funnel …: not applied` у лозі, сервер стартує все одно. Після перейменування машини наступний старт сам відкриє шляхи на новому імені; оновити URL у GitLab і GitHub; запис для старого імені в `tailscale funnel status` нешкідливий (старе ім'я вже не резолвиться).

```sh
tailscale funnel status                                  # що відкрито
tailscale funnel --https=443 --set-path=/factory/gitlab off   # прибрати шлях (і з FUNNEL_ROUTES, інакше старт поверне)
tailscale funnel --https=443 off                              # закрити все
```

Дозвіл на Funnel — у політиці tailnet (`nodeAttrs`, `attr: funnel` для цієї машини). Не відкривати Funnel на весь порт сервера (`/` → `:5874`): тоді UI і API стануть публічними.

`MASTRACODE_PUBLIC_URL` задає `server.env`, не `.env` проєкту: `start:local` і `dev:local` у `package.json` самі ставлять `http://localhost:5874`, якщо змінної немає, і це перекриває `.env`. Без неї Google після входу повертає на `localhost`.

Керування (на Mac mini):

```sh
launchctl kickstart -k gui/$UID/ai.eclipt.factory   # перезапустити
launchctl bootout gui/$UID/ai.eclipt.factory        # зупинити (наприклад, для e2e)
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/ai.eclipt.factory.plist   # увімкнути знову
launchctl print gui/$UID/ai.eclipt.factory | grep -E 'state|pid'               # стан
```

- **Відкат:** `scripts/mac-mini/deploy.sh <попередній коміт>` (збирає й вмикає його разом з його `start-server.sh`; коміт до ADR-0040 повертає `dev:local`). Швидше, без збірки: `scripts/mac-mini/deploy.sh --rollback` — `current` на попередню зібрану версію, її `start-server.sh`, `kickstart -k`. Дані після production-запуску ті самі, повертати БД не треба; копія `backup-…-before-prod-mode.db` — на крайній випадок (сервер зупинити, `mastra.db`, `-wal`, `-shm` відкласти, копію покласти як `mastra.db`).
- **Перенести папку проду:** змінити `FACTORY_RUNTIME` у `server.env` і викотити (автозапуск переключиться сам); стару папку — `git worktree remove` кожної її версії. Переносити `mv` не можна: версії — worktree, а збірка тримає абсолютні шляхи.
- **Не вбивати за PID і не запускати `pnpm dev:*` поруч**: launchd підніме сервер знову через 30 с, і два екземпляри впадуть на «Another development server instance is already running». Для повного перезапуску — `kickstart -k`; для e2e чи ручного запуску — спершу `bootout`, після — `bootstrap`.
- Поки сервер не відповідає, сторінка показує зверху плашку «Сервер не відповідає — можливо, перезапускається» з відліком до наступної перевірки й «Спробувати зараз»; коли `/health` відповів — «Сервер знову доступний», запити TanStack Query на цей час стають на паузу (`onlineManager`) і продовжуються самі (`apps/ui/src/ui/lib/serverReachability`). Сторінка, відкрита вже під час простою, бачить «502 Bad Gateway» від Tailscale.
- Після зміни імені машини чи tailnet адреса сервісу не змінюється; змінилась адреса — `install.sh <нова адреса>` і клієнт Google.
- Щоб мак вмикався сам після вимкнення світла: `sudo pmset autorestart 1`; LaunchAgent і Tailscale стартують лише після входу користувача (автологін; з FileVault — пароль на самому маку).

## e2e

- Під час e2e файли не редагуються (сервер перезапуститься й усі тести впадуть).
- Для e2e дозволено зупинити дев-сервер; після — запустити знову.
