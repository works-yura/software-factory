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

## Розділ «Інтеграції»

Рішення: [ADR-0027](../../adr/0027-integrations-services-and-mcp.md). `/settings/integrations` у групі «Factory», вкладки в URL (`?tab=services|mcp`, `&service=google-cloud|clickup|github|gitlab`).

- **Сервіси** (`IntegrationsSection.tsx`): картки зі станом, що відкривають налаштування: Google Cloud ([google-cloud](../google-cloud/design.md)), ClickUp, GitHub, GitLab (`SourceControlServices.tsx`).
- **MCP**: [mcp-servers](../mcp-servers/design.md).
- Старі `/settings/observability` і `/settings/mcp-servers` переводять сюди (`RETIRED_SETTINGS_SECTIONS`, `settingsSections.ts`); «Репозиторії» — лише вибір репозиторіїв, «Надходження задач» — лише маршрути.
