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
