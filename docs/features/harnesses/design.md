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
