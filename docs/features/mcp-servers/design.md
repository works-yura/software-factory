# MCP-сервери

Зовнішні MCP-сервери, якими користуються агенти (база через MCP Toolbox, згодом логи, Sentry). Рішення: [ADR-0025](../../adr/0025-mcp-servers-manager.md).

## Що бачить людина

Налаштування › **MCP-сервери** (`/factories/<factory>/settings/mcp-servers`), для всієї організації:

- **Сервер:** назва, ідентифікатор (агент бачить інструменти як `<ідентифікатор>_<інструмент>`), тип — пресет («MCP Toolbox for Databases · Firestore», «… · own tools.yaml»), власна команда (stdio) або адреса (HTTP).
- **Змінні й секрети:** звичайні змінні видно; секретні (змінні, заголовки, файли на кшталт ключа сервісного акаунта) вводяться раз і більше не показуються — лише їхні імена. Порожнє поле при збереженні лишає збережене значення.
- **Доступ** (налаштування 1): список Factory; для кожної — необов'язково лише деякі дошки й фази. Без дошок і фаз сервер отримують усі сесії Factory, зокрема чат; з обмеженням — лише сесії карток на цих дошках і фазах. Новий сервер не отримує ніхто.
- **Інструменти** (налаштування 2): «Перевірити» запускає сервер і показує його інструменти; для кожного — «Дозволено» / «З підтвердженням» / «Заборонено», плюс типова політика сервера (за замовчуванням «Дозволено»). Інструменти пресета, що змінюють дані, позначено «змінює дані» — нічого не забороняється без людини.
- **Маскувати персональні дані** (типово так), **Увімкнено**.
- Член організації бачить сервери лише для читання; змінює адмін організації.

## Як це працює

- **Сховище:** `McpServersStorage` (`packages/store/src/mcp-servers/base.ts`, таблиця `factory_mcp_servers`): конфіг запуску (`McpServerLaunch`), доступ, політика, маскування, увімкнення; секрети — один зашифрований JSON. Модель і чисті правила — `packages/core/src/mcp-servers/model.ts` (`mcpServerAvailable`, `mcpToolPolicy`, `mcpAgentToolName`).
- **API:** `packages/server/src/mcp-servers/routes.ts` — `GET/POST /web/mcp-servers`, `PUT/DELETE /web/mcp-servers/:id`, `POST /web/mcp-servers/:id/status`. Відповіді без значень секретів, `Cache-Control: no-store`, записи — адмін, аудит `factory.mcp_server.created|updated|deleted`.
- **Хаб:** `packages/server/src/mcp-servers/hub.ts` (`McpServerHub`). Область сесії (`scope.ts`): Factory з контексту запиту, картка — через `listWorkItemIdsForSession`, її дошка й фаза (одна фаза; картка в кількох фазах фази не називає). Для сесії — `MCPClient` з усіма призначеними серверами, кеш за сесією й версією налаштувань серверів, зупинка після 15 хв простою, `release`, вимкнення Factory. Кожен інструмент загорнутий: `deny` не видається, `ask` — `requireApproval`, результат маскується за налаштуванням, виклик — аудит `factory.mcp_server.tool_called`.
- **Запуск:** `launch.ts` — пресет або команда, `${VAR}` в аргументах лише зі змінних сервера, секретні файли в `mkdtemp` (0700, файли 0600), видаляються при зупинці; оточення процесу — лише його змінні плюс `PATH`/`HOME`. Пресети — `presets.ts`, пакет із `node_modules`, запуск поточним Node.
- **Сесії:** `sessionExtraTools` у `packages/server/src/factory.ts` додає інструменти хаба: Mastra — у процесі, Claude Code і Codex — через MCP-ендпоінт Factory. Claude Code: `mcpAskToolsFor` у `packages/server/src/claude/harness.ts` додає `mcp__factory__<tool>` до `askEachTime`. Codex: інструменти «з підтвердженням» не видаються.

## Як додати

- **Ще одну базу** — сервер у налаштуваннях з пресетом «own tools.yaml» (Postgres, MySQL, MongoDB, BigQuery… — див. документацію Toolbox).
- **Новий пресет** — запис у `MCP_SERVER_PRESETS` (пакет у залежностях `packages/server` з точною версією, аргументи, обов'язкові змінні й секретні файли, інструменти, що пишуть) і тест у `hub.test.ts`.
- **Інший MCP-сервер з npm** — залежність з точною версією і пресет, або «власна команда» з шляхом до встановленого бінарника.

## Де в коді

- Модель: `packages/core/src/mcp-servers/model.ts`
- Сховище: `packages/store/src/mcp-servers/base.ts`
- Хаб, запуск, пресети, область, маршрути: `packages/server/src/mcp-servers/`
- Маскування: `packages/capabilities/src/redact.ts`
- UI: `apps/ui/src/ui/domains/settings/components/McpServersSection.tsx`, `services/mcpServers.ts`, `hooks/useMcpServers.ts`
