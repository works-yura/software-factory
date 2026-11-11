# Документація Factory v4

Factory — фабрика агентів для розробки клієнтських проєктів (Syncta, PostAirborne та інші). Дошка «Продукт» веде зміну від ідеї до погодженого брифу, специфікації й задач; дошка «Розробка» — від задачі до PR і рев'ю. Агенти працюють на Mastra або Claude Code у пісочниці картки. Код — власна копія Mastra Factory ([ADR-0001](adr/0001-v4-own-copy-of-mastra.md)).

Документація ведеться за нашим стандартом — [rules/docs-standard.md](rules/docs-standard.md); він же обов'язковий для документації клієнтських проєктів.

## Розділи

| Розділ | Що там |
| --- | --- |
| [features/](features/INDEX.md) | правда: як працює кожна область зараз |
| [adr/](adr/README.md) | рішення і чому їх прийняли |
| [rules/](rules/) | обов'язкові правила: [стандарт документації](rules/docs-standard.md), [робота з кодом](rules/engineering.md) |
| [runbooks/](runbooks/) | як робити: [дев-сервер](runbooks/dev-server.md), [логи й креші Firebase](runbooks/firebase-observability.md), [база через MCP Toolbox](runbooks/mcp-toolbox-firestore.md) |
| [repositories/](repositories/factory-v4.md) | огляд репозиторію й пакетів |
| [changes/backlog.md](changes/backlog.md) | відкрите й відкладене |
| [GLOSSARY.md](GLOSSARY.md) | терміни |
| `QUESTIONS.md` | питання й відповіді про задум фабрики (локальний файл, у git не відстежується) |
| [../MIGRATION.md](../MIGRATION.md) | перенос v3 → v4 і з upstream Mastra, наші відхилення |

## Чого тут нема і чому

- `blackbox/`, `client/`, `design/` — це наш власний продукт: нема клієнта, його джерел, документів на підпис і окремого візуального дизайну (UI — дизайн-система з Mastra).
- `changes/<дата>-<зміна>/` — зміни фабрики поки не йдуть через дошку «Продукт»; рішення записані в `adr/`, відкладене — у `changes/backlog.md`.
- `bugs/`, `audits/`, `tools/` — ще нема записаних багів, аудитів і скриптів для документації; розділ з'являється з першим записом.
