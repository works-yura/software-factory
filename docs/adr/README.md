# Рішення (ADR)

Великі рішення фабрики: що вирішили, чому і що відкинули. Формат — `packages/harness-mastra/factory-skills/product-enrich/references/ADR-FORMAT.md`. Нумерація наскрізна; рішення не переписують — нове замінює старе (`Статус: замінено ADR-NNNN`).

| # | Рішення | Дата |
| --- | --- | --- |
| [0001](0001-v4-own-copy-of-mastra.md) | v4 — власна копія Mastra Factory, upstream переносимо вибірково | 2026-10-27 |
| [0002](0002-boards-in-code.md) | Дошки задаються кодом; «Продукт» не пише код; PR рев'юються на «Розробці» | 2026-11-10 |
| [0003](0003-product-phases-and-gates.md) | Фази й ворота дошки «Продукт» | 2026-11-10 |
| [0004](0004-brief-rules.md) | Правила брифу для клієнта | 2026-11-10 |
| [0005](0005-docs-standard.md) | Єдиний стандарт документації проєкту | 2026-11-10 |
| [0006](0006-questions-through-cards.md) | Кожне питання до людини — карткою питань | 2026-11-10 |
| [0007](0007-task-from-card-not-github-issue.md) | Задача береться з картки (ClickUp), не з GitHub issue | 2026-11-10 |
| [0008](0008-agent-language.md) | Мова агентів — налаштування фабрики, типово українська | 2026-11-10 |
| [0009](0009-attachments-storage-adapter.md) | Вкладення через адаптер сховища | 2026-11-10 |
| [0010](0010-chat-references-registry.md) | Посилання в чаті — реєстр видів | 2026-11-10 |
| [0011](0011-chat-markdown-no-html.md) | Чат показує лише Markdown; скіли не пишуть HTML у чат | 2026-11-10 |
| [0012](0012-no-claude-code-attribution.md) | Без атрибуції Claude Code у комітах і PR | 2026-11-10 |
| [0013](0013-claude-never-bypass-permissions.md) | Claude Code harness ніколи не обходить дозволи | 2026-10-27 |
| [0014](0014-ui-from-design-system.md) | UI будується з частин дизайн-системи | 2026-11-10 |
| [0015](0015-intake-rules-and-audits.md) | Правила надходження: тригер → політика → дія; дошка «Аудити» | 2026-11-11 |
| [0016](0016-intake-rules-ports-and-adapters.md) | Правила надходження: порти й адаптери; картку правила ставлять маршрути | 2026-11-11 |
| [0017](0017-observability-firebase.md) | Логи й креші для агентів: можливість observability, Firebase як перший адаптер | 2026-11-11 |
| [0018](0018-conversation-channels.md) | Розмови з агентом: один провайдер-нейтральний канал, ClickUp — перший адаптер | 2026-11-11 |
| [0019](0019-observability-accounts-and-bindings.md) | Логи й креші: багато акаунтів Google Cloud, прив'язки Factory → проєкт | 2026-11-11 |
