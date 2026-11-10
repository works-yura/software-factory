# Налаштування Factory, що змінюють поведінку агентів

## Мова агентів

Рішення: [ADR-0008](../../adr/0008-agent-language.md).

- «Налаштування › Моделі», під перемикачем harness: «Українська» / «English»; типово українська, і для наявних Factory (колонка `agent_language`, типово `uk`).
- Сервер додає рядок мови в системні інструкції кожної сесії обох harness — карток, звичайних чатів і чату Factory; мова читається щоходу. Код, ідентифікатори, шляхи, команди, цитати й тексти для клієнта лишаються своєю мовою.
- Сесія без Factory рядка не отримує; Factory, яку не знайдено, — помилка ходу, а не тиха відповідь без мови.

## Де в коді

- `packages/server/src/agent-language.ts`; Mastra — `hostInstructions` у `packages/server/src/factory.ts`; Claude Code — `appendSystemPromptFor` у `packages/server/src/claude/harness.ts`.
- Збереження: `packages/store/src/projects/base.ts`; контракт: `packages/contracts/src/contracts.ts`.
- UI: `apps/ui/src/ui/domains/settings/components/models/AgentLanguageSection.tsx`.
