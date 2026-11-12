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

## Розділ «Підключення»

Рішення: [ADR-0031](../../adr/0031-connections-one-list.md) (раніше «Інтеграції» з вкладками, [ADR-0027](../../adr/0027-integrations-services-and-mcp.md)). Шлях лишився `/settings/integrations`, група «Factory».

- **Список Factory** (`components/connections/ConnectionsSection.tsx`, `ConnectionList.tsx`): інтеграція (позначка MCP), акаунт, можливості, стан, меню «⋮» — «Відкрити», «Перепідключити», «Перейменувати», «Відв'язати від Factory», «Видалити з організації» (що дозволяє вид). Рядки будує `connections/connections.ts` зі стану інтеграцій: прив'язки Google Cloud цієї Factory (з «Базою» в тому ж рядку), MCP-сервери з доступом цієї Factory, ClickUp / GitHub / GitLab на всю організацію.
- **Рядок відкриває свою сторінку** (`?connection=google-cloud:<прив'язка>|mcp:<сервер>|mcp-new:<запис каталогу>|google-cloud|clickup|github|gitlab`, `ConnectionDetail.tsx`) з наявними налаштуваннями: [google-cloud](../google-cloud/design.md), [mcp-servers](../mcp-servers/design.md), ClickUp, GitHub, GitLab (`SourceControlServices.tsx`). `&account=<id>` відкриває нову прив'язку через цей акаунт.
- **«Додати підключення»** (`AddConnectionDialog.tsx`, кроки — `ConnectSteps.tsx`): `Dialog` `md` з `Command` кіта — пошук і «Усі / Інструменти / Джерела» в одному рядку (`CommandInput rightSlot`), список у `ScrollArea`, рядки `CommandItem` з клавіатурою; розділи «Акаунти організації» (під'єднати акаунт Google Cloud чи MCP-сервер), «Інтеграції» (Google Cloud, ClickUp, GitHub, GitLab — логотип і значки можливостей) і «Інше» («Власний сервер MCP», сторонні записи каталогу). Інтеграція першої сторони відкриває крок «Підключити X» у тому ж вікні: Google Cloud — акаунт або новий ключ з поступом, помилкою («Не вдалося підключити», «Спробувати знову») і успіхом; ClickUp / GitHub / GitLab — стан і їхні керування. Записи каталогу, які запускає інтеграція (`entry.integration`), не пропонуються. Логотипи — `simple-icons` (`ConnectionIcon.tsx`).
- **«Активність»** (`ConnectionActivity.tsx`): виклики MCP цієї Factory за 24 години (`GET /web/mcp-servers/activity`).
- **Телефон:** рядки складаються в картки; «Додати підключення» — на весь екран з відступами безпечної зони; кнопки ≥ 44 px; без горизонтальної прокрутки.
- Старі `?tab=…&service=…`, `/settings/observability` і `/settings/mcp-servers` переводять сюди (`RETIRED_SETTINGS_SECTIONS`, `connectionsPath`, `settingsSections.ts`); «Репозиторії» — лише вибір репозиторіїв, «Надходження задач» — лише маршрути.
