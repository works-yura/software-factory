# Harness: Mastra і Claude Code

Сесія агента працює на одному з двох harness; вибір — на Factory («Налаштування › Моделі»). Рішення: [ADR-0008](../../adr/0008-agent-language.md), [ADR-0012](../../adr/0012-no-claude-code-attribution.md), [ADR-0013](../../adr/0013-claude-never-bypass-permissions.md).

## Mastra

- Пакет `packages/harness-mastra`; системні інструкції фабрики — `hostInstructions` у `packages/server/src/factory.ts`.
- Інструменти фабрики (`factory_*`) і скіли з workspace.

## Claude Code

- Пакет `packages/harness-claude-code-core` запускає `claude` CLI; сервер — `packages/server/src/claude/`.
- Ніколи `bypassPermissions` / `--dangerously-skip-permissions` (`cli.ts` кидає помилку). Дозволи — правила фабрики (allow / ask / deny) і підтвердження в чаті; налаштування й MCP-сервери людини в сесію не потрапляють (`--setting-sources`, `--strict-mcp-config`).
- `AskUserQuestion` повертає «очікує дозволу», відповідь людини приходить через `answerQuestion`.
- Скіли — через `skill_read`; сесії карток «Продукту» мають `WebFetch` / `WebSearch` без підтвердження.
- CLI отримує `--settings` з `attribution: { commit: '', pr: '' }` — без «Generated with Claude Code» і `Co-Authored-By` (`session.ts`).
- Системні інструкції — `appendSystemPromptFor` у `packages/server/src/claude/harness.ts`.

## OpenCode

- Рішення: [ADR-0043](../../adr/0043-opencode-harness-free-models.md). Пакет `packages/harness-opencode-core` (`@factory/harness-opencode`); сервер — `packages/server/src/opencode/`.
- Один `opencode serve` на запуск: `127.0.0.1`, вільний порт, власний пароль; HTTP + SSE (`/event`), без SDK. Мінімальна версія CLI — 1.14.19.
- Стан OpenCode — у власних `XDG_*` теках сесії (`~/.mastracode/web/opencode-sessions-home/<сесія>`), без ключів і входу; `~/.config/opencode` людини не читається. Конфіг Factory (дозволи, MCP `factory` з токеном запуску) — `OPENCODE_CONFIG_CONTENT`.
- Моделі — безкоштовні моделі OpenCode Zen (`opencode/big-pickle` типова), у виборі з позначкою «Безкоштовно». **На репозиторіях клієнтів — лише зі згоди клієнта.** З обліковим записом організації — також платні моделі Zen і OpenCode Go.
- Обліковий запис OpenCode (ADR-0043, доповнення 1): конектор «OpenCode» у Налаштуваннях › Підключення, ключ із консолі OpenCode (перевіряється при додаванні), на рівні організації. Запуск входить із ним через `OPENCODE_AUTH_CONTENT`; без запису — безкоштовні моделі. `packages/server/src/opencode/accounts.ts`, `packages/api/src/opencode-connections.ts`.
- Ліміти: вікна OpenCode Go (5 год, тиждень, місяць) — на сторінці підключення й у переглядах використання; вичерпаний запис виходить із ротації до скидання; чат-сесія паркується, коли час повернення відомий. Безкоштовні моделі часу не кажуть — хід завершується з їхніми словами.
- «Продовжити сесію OpenCode» (лише на власній машині людини): список її сесій із `~/.local/share/opencode/opencode.db` (лише читання), нова приватна сесія Factory на OpenCode з історією й handoff на перший хід. `packages/harness-opencode-core/src/local-sessions.ts`, `packages/server/src/opencode/local-import.ts`, `packages/api/src/opencode-local-sessions.ts`, UI — `OpenCodeImportDialog.tsx`.
- Дозволи: `edit` / `bash` з налаштувань Factory (без налаштування — питати); вихід за межі чекауту питає завжди; «дозволити все» немає. Питання (`question`) — картка `AskUserQuestion`; планування — агент `plan`.
- Запуск від імені агента (ADR-0041): `opencode` копіює `agent-tools`; профіль Seatbelt діє.
- Перевірка на справжньому CLI: `FACTORY_OPENCODE_SMOKE_COMMAND=$(which opencode) npx vitest run src/real-cli.integration.test.ts` у пакеті.
- Дозволи: перше правило конфігу — `*: ask` (інструмент без правила, як-от MCP-сервер з `opencode.json` чекауту, питає), MCP Factory — `<server>_*: allow`; `external_directory` і `doom_loop` дозволяються лише раз, не на нитку. Зміна налаштувань між ходами одного запуску перезапускає сервер з новими правилами в тій самій сесії OpenCode.
- Паритет тестів із t3code (що перенесено, що н/з і чому, знайдені помилки) — [opencode-test-parity.md](opencode-test-parity.md).

## Спільне

- Рядок мови агентів додається в інструкції обох harness щоходу (`packages/server/src/agent-language.ts`).
- Сесії карток працюють у пісочниці картки: одна папка на картку, спільна для її сесій.

## Ліміти використання

- Вікна лімітів акаунта (5 годин, тиждень, тижневий ліміт моделі «Тиждень · Opus», місяць, додаткове використання) — один тип `UsageWindow` (`packages/harness-core/src/usage/`). Harness дає їх через свій usage-фасет: пробу провайдера (`readAccountLimits`) і `usage_limits_update` під час ходу. UI не знає, який harness їх прислав.
- Claude Code: `rate_limit_event` у потоці (частка 0–1) і `GET https://api.anthropic.com/api/oauth/usage` (0–100; також `seven_day_opus` / `seven_day_sonnet`, `model_scoped`, `extra_usage` / `spend` → вікно «Додаткове використання»). Codex: `account/rateLimits/updated` і `GET https://chatgpt.com/backend-api/wham/usage` — `primary` / `secondary` з довжиною вікна в хвилинах.
- Одиниці: частка з потоку, що помітно більша за 1, читається як відсотки (`normalizeUsedPercent`); значення ≤ 1 % там, де в тому ж періоді було ≥ 5 % і стократ більше відповідає збереженому, вважається часткою (`reconcileUsageWindow`). Обидва випадки пишуться в лог.
- Де видно: індикатор у рядку статусу чату (кільце найтіснішого вікна акаунта останнього ходу сесії, відсоток і час до оновлення; поповер — усі вікна), «Налаштування › Моделі» під кожним входом, «Налаштування › Аналітика › Ліміти» — картка на кожен вхід. Від 80 % — бурштиновий, від 95 % — червоний; вікно, час оновлення якого минув, читається як порожнє.
- API: `GET /web/usage/limits[?refresh=1]` (усі harness разом) і `GET /web/config/providers/:provider/accounts/usage[?refresh=1]`; провайдера питають не частіше разу на хвилину на акаунт, інакше відповідь позначено `stale`.
- Mastra працює з API-ключами: ліміти підписки в них відсутні, а заголовки `anthropic-ratelimit-*` / `x-ratelimit-*` — похвилинні ліміти запитів і токенів, а не вікна використання, тож Mastra ліміти не показує.
