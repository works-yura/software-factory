# 0012. Без атрибуції Claude Code у комітах і PR

Дата: 2026-11-10 · Статус: прийнято · Коміт: `02b85bd`

**Контекст.** Claude Code CLI типово дописує «🤖 Generated with Claude Code» в опис PR і `Co-Authored-By: Claude` у коміти. Коміти й PR агентів фабрики — робота команди для клієнта.

**Рішення.** Сесія Claude Code передає CLI налаштування `attribution: { commit: '', pr: '' }` (`packages/harness-claude-code-core/src/session.ts`); `attribution: false` у конфігурації сесії лишає типову поведінку CLI.

**Наслідки.** На живому PR ще не перевірено, що CLI дотримується налаштування (`changes/backlog.md`).
