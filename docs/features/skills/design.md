# Скіли агентів

Скіл — інструкція агенту на кроці дошки (`SKILL.md` + `references/`). Рішення: [ADR-0006](../../adr/0006-questions-through-cards.md), [ADR-0007](../../adr/0007-task-from-card-not-github-issue.md), [ADR-0011](../../adr/0011-chat-markdown-no-html.md).

- **Джерело:** `packages/harness-mastra/factory-skills/<name>/`. Скіли `factory-*` — з upstream Mastra з нашими змінами (записані в `MIGRATION.md`); `product-*` — наші.
- **На сервер:** `apps/server` при старті (`corepack pnpm dev:local`) запускає `sync:skills` і копіює їх у `apps/server/src/mastra/public/factory-skills`. Зміна скілу діє лише після повного перезапуску сервера ([runbook](../../runbooks/dev-server.md)).
- **У сесію:** Mastra читає скіли з workspace; Claude Code — інструментом `skill_read` (`packages/server/src/claude/skill-read.ts`).
- **Правила тексту:** у чат — лише Markdown без HTML; кожне питання людині — інструментом питань; мову відповіді задає налаштування фабрики ([settings](../settings/design.md)), а не скіл.

| Скіл | Де працює |
| --- | --- |
| `product-enrich`, `product-brief`, `product-spec`, `product-phases` | «Продукт»: Дослідження, Бриф, Специфікація, Фази |
| `factory-triage`, `factory-plan`, `factory-self-review` | «Розробка»: Розбір, Планування, Рев'ю |
| `factory-review`, `factory-rereview`, `factory-gitlab-review`, `factory-gitlab-rereview` | «Розробка»: Рев'ю PR |
| `factory-docs-sync` | «Розробка»: задача злиття документації зміни |
| `configure-factory-rules` | налаштування правил фабрики |
