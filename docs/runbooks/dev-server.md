# Дев-сервер

## Запуск

```sh
cd apps/server
corepack pnpm dev:local
```

- Вхід через Google (`FACTORY_AUTH=google`; `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `FACTORY_AUTH_SECRET` у `apps/server/.env`, див. README).
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

| Що | Де |
| --- | --- |
| Адреса | `https://factory.tail5c61c7.ts.net` — лише в tailnet; Tailscale Service `svc:factory` (машина з тегом `tag:server`), проксі на `http://127.0.0.1:5874` |
| Автозапуск сервера | LaunchAgent `ai.eclipt.factory` (шаблон `scripts/mac-mini/ai.eclipt.factory.plist`): `RunAtLoad`, `KeepAlive` лише при невдалому виході, `ThrottleInterval` 30 с |
| Скрипт запуску | `scripts/mac-mini/start-server.sh`: node з `nvm` (`default`), чекає диск із проєктом (до 5 хв), читає `server.env` і запускає `corepack pnpm dev:local` в `apps/server` |
| Сторож | той самий скрипт: кожні 20 с `GET http://127.0.0.1:5874/health` (відповідає без входу); 6 невдач поспіль (2 хв) — зупиняє всю групу процесів і виходить з 1, launchd піднімає знову. Потрібен, бо `mastra dev` живе далі, коли сервер у ньому впав. Старт до першої здорової відповіді — до 15 хв. Рядки `[watchdog …]` у лозі |
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

`MASTRACODE_PUBLIC_URL` задає `server.env`, не `.env` проєкту: `dev:local` у `package.json` сам ставить `http://localhost:5874`, якщо змінної немає, і це перекриває `.env`. Без неї Google після входу повертає на `localhost`.

Керування (на Mac mini):

```sh
launchctl kickstart -k gui/$UID/ai.eclipt.factory   # перезапустити
launchctl bootout gui/$UID/ai.eclipt.factory        # зупинити (наприклад, для e2e)
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/ai.eclipt.factory.plist   # увімкнути знову
launchctl print gui/$UID/ai.eclipt.factory | grep -E 'state|pid'               # стан
```

- **Не вбивати за PID і не запускати `pnpm dev:*` поруч**: launchd підніме сервер знову через 30 с, і два екземпляри впадуть на «Another development server instance is already running». Для повного перезапуску — `kickstart -k`; для e2e чи ручного запуску — спершу `bootout`, після — `bootstrap`.
- Поки сервер не відповідає, сторінка показує зверху плашку «Сервер не відповідає — можливо, перезапускається» з відліком до наступної перевірки й «Спробувати зараз»; коли `/health` відповів — «Сервер знову доступний», запити TanStack Query на цей час стають на паузу (`onlineManager`) і продовжуються самі (`apps/ui/src/ui/lib/serverReachability`). Сторінка, відкрита вже під час простою, бачить «502 Bad Gateway» від Tailscale.
- Після зміни імені машини чи tailnet адреса сервісу не змінюється; змінилась адреса — `install.sh <нова адреса>` і клієнт Google.
- Щоб мак вмикався сам після вимкнення світла: `sudo pmset autorestart 1`; LaunchAgent і Tailscale стартують лише після входу користувача (автологін; з FileVault — пароль на самому маку).

## e2e

- Під час e2e файли не редагуються (сервер перезапуститься й усі тести впадуть).
- Для e2e дозволено зупинити дев-сервер; після — запустити знову.
