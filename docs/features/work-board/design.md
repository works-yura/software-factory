# Дошка «Розробка»

*Як* зробити: задача → план → код → PR → рев'ю. Id `work`; у UI — «Розробка». Рішення: [ADR-0002](../../adr/0002-boards-in-code.md), [ADR-0007](../../adr/0007-task-from-card-not-github-issue.md).

## Фази

| Фаза | Id | Контекст сесії | Скіл |
| --- | --- | --- | --- |
| Вхідні | `intake` | — | — |
| Розбір | `triage` | `triage` | `factory-triage` |
| Планування | `planning` | `work` | `factory-plan` (вихід — `submit_plan`, людина схвалює) |
| Збірка | `execute` | `work` | `factory-build` (відкриває PR і переносить картку в Рев'ю) |
| Рев'ю | `pr-review` | `review` | `factory-review` / `factory-rereview` (GitLab — `factory-gitlab-*`) |

Самоперевірки (`review`, `factory-self-review`) у новій Work немає (upstream #29724). Проєкти, збережені раніше, зберігають її у своєму рядку дошки; будь-яка дошка може додати її як робочу фазу в контексті `review` лише з `factory_record_review_verdict`.
| Готово / Скасовано | `done` / `canceled` | — | — |

Планування і збірка ділять одну сесію, тож збирач має контекст плану.

## Звідки задача

Картки приходять з ClickUp (intake: список ClickUp має бути прив'язаний до дошки) або заводяться вручну; «Продукт» створює задачі сам. Скіли беруть задачу з картки (назва, опис, коментарі), а не з GitHub issue. Розбір пише висновок у чат звичайним Markdown; план — `.artifacts/plans/<card-id>.md`. GitHub/GitLab — лише код і PR.

## Документація проєкту

- **Читають перед роботою.** Планування, збірка й самоперевірка читають `features/<область>/design.md` зачеплених областей, `rules/`, `bugs/INVARIANTS.md`; задача зміни — ще свої розділи `changes/<зміна>/design.md` і `tasks.md#id`. Як знайти папку документації — `factory-docs-sync/references/project-docs.md`. Нема папки — агент каже про це в підсумку.
- **Відхилення.** Задача зміни не править документацію: розбіжності зі специфікацією — розділ `## Deviations from design` в описі PR/MR.
- **Злиття зміни — окрема остання задача** (`<префікс>-DOCS`, `docsSync: true`, скіл `factory-docs-sync`): план злиття дельти в планування, застосування в збірці, перенос у `changes/archive/`, PR/MR у репозиторії документації. Скіл зупиняється, якщо інші задачі зміни не змерджено. Окрема картка, а не крок на «Готово»: прибирання завершеної картки зупиняє її сесії й видаляє пісочницю, а правило дошки не бачить сусідніх карток.
- **Баги.** Розбір підтвердженого бага пише першу частину `bugs/<id>.md` у гілці картки; виправлення дописує решту й відкриває PR/MR документації поруч із кодом.

## Де в коді

- Дошка: `packages/pipelines/src/work/board.ts` — кожна фаза запускає скіл свого виконавця (`runner`); Building — як мету (`BUILD_OBJECTIVE`). Документація: `packages/pipelines/src/work/docs.ts`.
- Картку агент бачить у сигналі `factory-work-item` (`packages/harness-mastra/src/rules/work-item-state-processor.ts`): джерела, стан Factory, блок Docs; задача злиття документації — блок «Docs sync».
- Intake ClickUp: `packages/integration-clickup/src/{intake,poller}.ts`.
- Скіли: `packages/harness-mastra/factory-skills/factory-*`.
