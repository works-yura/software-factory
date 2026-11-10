# Репозиторій factory v4

Монорепозиторій фабрики (pnpm workspace). Походження й перенос з upstream — [MIGRATION.md](../../MIGRATION.md), `migration/`, [ADR-0001](../adr/0001-v4-own-copy-of-mastra.md).

## Застосунки

| Шлях | Що це |
| --- | --- |
| `apps/server` | Mastra-сервер фабрики; дев-запуск — [runbook](../runbooks/dev-server.md) |
| `apps/ui` | інтерфейс фабрики (React); збірка в `apps/ui/dist` віддається сервером |

## Пакети (`packages/`)

| Група | Пакети |
| --- | --- |
| Ядро й дошки | `core` (дошки, правила), `pipelines` (дошки `work`, `product`), `work-items`, `runtime` (переходи, диспетчер) |
| Сервер | `server` (фабрика, Claude-сесії, правила), `api`, `contracts`, `http`, `auth`, `credentials`, `supervisor`, `session`, `feed`, `activity`, `observability`, `capabilities`, `mcp` |
| Дані | `store` (домени БД, вкладення) |
| Агенти | `harness-core`, `harness-mastra` (+ `factory-skills/`), `harness-claude-code-core`, `harness-claude-code-ui`, `sandbox`, `internal-workspace` |
| Інтеграції | `integrations`, `integration-github`, `integration-gitlab`, `integration-clickup` |
| UI-бібліотека | `playground-ui` (дизайн-система з Mastra) |
| Тести | `testing` |

## Перевірка

- Типи й тести пакета: `corepack pnpm -s typecheck`, `npx vitest run` у його папці.
- `corepack pnpm verify` — перевірки, тести, контракти, e2e (запускає дев-сервер) і звірка кількості тестів з v3 (`scripts/compare-tests.sh`, `migration/test-pairs.tsv`).
