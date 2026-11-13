# 0040. Mac mini: сервер працює зі збірки (production), на тих самих даних, що й дев-сервер

Дата: 2026-11-13 · Статус: прийнято, зроблено.

**Контекст.** На Mac mini launchd запускав `pnpm dev:local` = `mastra factory dev`: `NODE_ENV=development`, стеження за файлами, `rm -rf .mastra/output` і повна збірка бандла на кожному старті (30–60 с до першої здорової відповіді, сторож чекав до 15 хв), процес `mastra dev` (~600 МБ) поруч із сервером. Сервер і так працює з викоченого слота (`v4-runtime/{a,b}`), файли там не змінюються, тож стеження нічого не дає. Вимога власника: production-запуск на **тих самих** даних — та сама `mastra.db`, `~/.mastracode/factory-v4`, той самий `.env`, ключ облікових даних, пісочниці.

**Що змінює `NODE_ENV=production` у вході (`apps/server/src/mastra/index.ts`).** Поза development вхід вимагає `DATABASE_URL` (libSQL заборонено), ключ шифрування (`FACTORY_CREDENTIAL_ENCRYPTION_KEY`; ключ машини `~/.mastracode/factory-local-dev-key` — лише development) і `FACTORY_SANDBOX_PROVIDER=local`; і вимикає «власну машину»: вхід Claude/ChatGPT, перегляд пристроїв. Тобто просто `NODE_ENV=production` або не стартує, або стартує з іншою БД/ключем і без частини функцій.

**Рішення.**
- **`FACTORY_OWN_MACHINE=1`** — явна згода «production-сервер на власній машині людини» (лише з `FACTORY_AUTH=google`). Дає те саме, що development на цій машині: libSQL без `DATABASE_URL` (`MASTRA_DB_PATH`), ключ машини з того самого файлу (ідентифікатор `v1`, як і раніше — збережені секрети розшифровуються), вхід Claude/ChatGPT, перегляд пристроїв. Без згоди production поводиться як і раніше (захисти старту не послаблено). Згода на запуск команд на хості лишається окремою: `FACTORY_SANDBOX_PROVIDER=local`.
- **`pnpm start:local`** (`apps/server`) — те саме середовище, що `dev:local` (ті самі `HOST`, `PORT`, `FACTORY_AUTH`, `MASTRA_DB_PATH`, `MASTRACODE_UI_DIST`, `MASTRACODE_PUBLIC_URL`, `varlock run` з тим самим `.env`), плюс `NODE_ENV=production`, `FACTORY_OWN_MACHINE=1`, `FACTORY_SANDBOX_PROVIDER=local`; запускає `mastra start` (бандл `.mastra/output`, зібраний `pnpm build`).
- **Збирає `deploy.sh`** у неактивному слоті (UI і бандл сервера); збірка впала — сервер лишається на старому слоті. Перед першим production-стартом — разова копія БД (`sqlite3 .backup` → `backup-<дата>-before-prod-mode.db`). `start-server.sh` тепер їде з комітом (deploy встановлює його зі слота), тож відкат на старий коміт повертає й старий запуск.
- **Запасний шлях — один рядок:** `FACTORY_SERVER_MODE=dev` у `server.env` → `dev:local`, як раніше. Слот без збірки теж падає на `dev:local` (з рядком у лозі).

**Наслідки (відмінності, які лишаються).** Робочий каталог сервера — `.mastra/output` (не `src/mastra/public`); навички Factory беруться з `.mastra/output/factory-skills` (той самий вміст). Логер Mastra за замовчуванням — `WARN` (у dev — `INFO`; журнали Factory через `console` не змінюються). Реєстр моделей — статичний з `@mastra/core` (dev оновлював його з мережі щогодини). better-auth вмикає обмеження частоти запитів (лише в production). Помилки HTTP без стеку; немає `/swagger-ui` і сторінки `/api`. Перезапуск активних workflow робить сам бандл на старті (у dev — `mastra dev` через `/__restart-active-workflow-runs`). Залежності бандла `mastra build` ставить окремо в `.mastra/output/node_modules` (з overrides кореня). Старт ~6 с замість 30–60 с, пам'ять ~0,7 ГБ замість ~1,1 ГБ.

**Альтернативи.**
- `NODE_ENV=development` зі збіркою — відкинуто: власник хоче production; і «development» далі вмикав би все, що з ним пов'язано.
- Ключ машини в `FACTORY_CREDENTIAL_ENCRYPTION_KEY` через `$(cat …)` у скрипті — відкинуто: ключ у командному рядку середовища, а вхід Claude/ChatGPT і пристрої однаково вимкнулися б.
- Окремі згоди на кожен пункт (БД, ключ, функції) — відкинуто: це одна обставина («сервер на моїй машині»), три змінні лише дають змогу зібрати неузгоджений стан.
