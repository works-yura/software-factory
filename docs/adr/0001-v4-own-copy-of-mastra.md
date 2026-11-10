# 0001. v4 — власна копія Mastra Factory, upstream переносимо вибірково

Дата: 2026-10-27 · Статус: прийнято

**Контекст.** Фабрика виросла з Mastra Factory (`mastracode/factory` у `mastra-ai/mastra`). Нам потрібні свої дошки («Продукт»), intake з ClickUp, Claude Code harness; частина upstream (Linear, Jira, Slack, WorkOS, E2B, особисті моделі) не потрібна.

**Рішення.** v4 — власний монорепозиторій пакетів, скопійований з v3 ([MIGRATION.md](../../MIGRATION.md)). Upstream переносимо по коміту скриптом `migration/tools/port-upstream.py` (3-way merge) за планом `migration/upstream-port-plan.md`; кожен перенос — коміт `(port of <sha>)` і рядок у `MIGRATION.md`. Поведінку, яку свідомо не міняємо, тримаємо як в оригіналі.

**Наслідки.** Перед зміною поведінки дивимось, як це зроблено в оригіналі. Наші відхилення (наприклад, [0007](0007-task-from-card-not-github-issue.md)) записуються в `MIGRATION.md`.

**Альтернативи.** Форк Mastra цілком — відкинуто: тягне непотрібні інтеграції й конфлікти на кожному оновленні.
