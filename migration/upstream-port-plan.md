# План переносу з upstream (mastra-ai/mastra), листопад 2026

База: `4c22623ea3` (див. `MIGRATION.md` → «Перенесено з upstream після 4c22623ea3»).
Upstream на 2026-11-04: `a403c993a0`. Від бази 177 комітів по `mastracode/factory*`, 32 вже перенесені.

## Що підтримує v4 (фільтр для кожного коміту)

- Джерела задач і код: GitHub, GitLab; intake з ClickUp (наш, в upstream його нема).
- Харнеси: Mastra (`harness-mastra`, `@mastra/code-sdk` як залежність npm, не як код), Claude Code.
- Дошки: Work, Review. Acceptance прибрано.
- Фабрика належить організації: особистих моделей і особистої пам'яті нема.

Не підтримуємо, тож з будь-якого коміту ці частини не беремо:
- Linear, Jira, incident.io, Slack, WorkOS;
- browser tools, Knowledge, CLI (`packages/cli`), шаблони `create-factory`;
- особисті моделі та пам'ять;
- зміни в `mastracode/sdk`: це наш `@mastra/code-sdk`, він оновлюється версією пакета, а не переносом.

## Як переносимо кожен коміт

1. `python3 migration/tools/port-upstream.py <sha> --dry-run`, потім те саме без `--dry-run`.
   Скрипт для кожного файлу коміту робить 3-way merge (`git merge-file`):
   - база — upstream до коміту, ours — файл v4, theirs — upstream після коміту;
   - файл v4 шукає за назвою і схожістю вмісту;
   - нові файли кладе поруч із уже знайденими сусідами;
   - конфлікти, де з обох боків лише імпорти, вирішує на користь v4 і виводить, які імена треба доімпортувати;
   - непідтримуване, згенероване, `.changeset` і README відкидає.
   Нічого не комітить. Якщо файл знайдено не туди, допоможе `--map upstream=v4`.
   Коміти — **строго в хронологічному порядку**: без попереднього коміту конфлікти розростаються.
2. Конфлікти (`grep -rln "^<<<<<<< v4" packages apps`) вирішуємо вручну, імпорти нових файлів переводимо на пакети v4.
3. Тести переносимо разом із кодом і оновлюємо `migration/test-pairs.tsv`.
4. `pnpm verify` має бути зеленим.
5. Один коміт на один upstream-коміт: `<type>(<scope>): ... (port of <sha>)`.
   Додаємо рядок у `MIGRATION.md` і записуємо, що відкинули.
6. Комітимо тільки свої шляхи (`git commit -- <paths>`).

Порядок хронологічний. Логічна залежність є лише в `0246c754fa` (#28914), перед етапом 2 звірити.

## Відповідність шляхів (основне)

| upstream `mastracode/factory/src/…` | v4 |
| --- | --- |
| `boards/work.ts`, `boards/work-transition-policy.ts`, `boards/work-tool-rules.ts` | `packages/pipelines/src/work/{board,transition-policy,tool-rules}.ts` |
| `boards/review.ts` | `packages/pipelines/src/review/board.ts` |
| `boards/{define-board,card-facts,semantics}.ts` | `packages/core/src/boards/` |
| `rules/{dispatcher,transition-service}.ts` | `packages/runtime/src/` |
| `storage/domains/{work-items,boards,intake,projects}/*` | `packages/store/src/<домен>/` |
| `integrations/{github,gitlab}/*` | `packages/integration-{github,gitlab}/src/` |
| `work-items/create-work-item.ts` | `packages/work-items/src/create-work-item.ts` |
| `routes/contracts.ts` | `packages/contracts/src/contracts.ts` |
| `routes/*` | `packages/api/src/` |
| `workspace.ts`, `rules/processor.ts`, `factory-skills/` | `packages/harness-mastra/` |
| `factory.ts` | `packages/server/src/factory.ts` |
| `mastracode/factory-ui/src/…` | `apps/ui/src/…` |
| `packages/playground-ui/src/…` | `packages/playground-ui/src/…` |

## Етап 1: швидкі виправлення GitHub/GitLab і надійність

| # | sha | PR | Що | Обсяг |
| --- | --- | --- | --- | --- |
| 1 | `625819c9d0` | #28971 | гонки при intake під час видалення фабрики та паралельних стартів | 8 файлів, 228 рядків |
| 2 | `3a769810f4` | #29230 | Triage один раз, а не на кожну правку чи коментар issue | 4 файли, весь коміт про GitHub/GitLab |
| 3 | `b1f0edbcee` | #29228 | простоююча фабрика не опитує БД (нові `claimable-work.ts`, `dispatch-wake.ts`) | 6 файлів, 411 рядків |

## Етап 2: дошки та pipeline

| # | sha | PR | Що | Обсяг | Примітки |
| --- | --- | --- | --- | --- | --- |
| 4 | `c29851e3f9` | #28978 | ревʼю PR на дошці Work | 926 рядків | звірити з `9314c78` і self-review у `pipelines/src/work/phase-rules.ts` |
| 5 | `30d026698a` | #29039 | правила переходів як конфіг дошки | 751 рядок | частина `workTransitionPolicy` стає декларативною; дошки в БД уже перенесені |
| 6 | `a9e57d7666` | #29109 | intake routes: куди потрапляє нова картка | 1.2k рядків | **питання:** у нас уже є маршрути за тегами ClickUp. Брати лише рушій (`boards/intake-routing.ts`, store) і підключати ClickUp, чи пропустити |

## Етап 3: розділення картки на work item і board item (з міграцією даних)

| # | sha | PR | Що | Обсяг (без непідтримуваних частин) |
| --- | --- | --- | --- | --- |
| 7 | `df73fe4b9d` | #28958 | окремі схеми work item і board item, `split-migration.ts` | ~850 рядків |
| 8 | `7691dc1673` | #28959 | перехід сховища карток на нову модель (`cards.ts`) | ~1.3k рядків |
| 9 | `6dee7d5451` | #28960 | факти провайдера незалежно від стану дошки | ~475 рядків |
| 10 | `e9106f3cdc` | #28961 | нормалізовані факти джерела в API та UI дошки | 365 рядків |
| 11 | `323925c21a` | #29235 | не видаляти картку, яку перевикористав паралельний create | 130 рядків |
| 12 | `886f72f9d9` | #29248 | опитування списку PR у GitHub не перевантажує БД | 150 рядків |

Правила етапу:
- №7–№10 переносимо підряд в одній гілці;
- `split-migration.ts` має перенести наявні дані `~/.mastracode/factory-v4/mastra.db`, без перейменувань і без порожньої бази;
- перед міграцією зробити копію БД і перевірити міграцію на копії;
- №11 і №12 тільки після №8.

## Етап 4: UI транскрипту

| # | sha | PR | Що | Обсяг | Примітки |
| --- | --- | --- | --- | --- | --- |
| 13 | `381bcd079d` | #28709 | серія викликів tools згортається в один рядок активності | 1.7k рядків, 23 нові файли | конфлікт у `MessageBubble.tsx` з `5d0c63e` (reasoning відкритий) |
| 14 | `96fcbc8332` | #28834 | анімований `AgentIndicator`, живий `ActivityLine` | 2.5k рядків | після №13 |
| 15 | `f925d17146` | #28394 | нова сесія пропонує картки з дошки та що вже злито | 2k рядків | лише UI; перевірити, що starters не посилаються на Linear чи Slack |

Перевірка: тести UI, збірка `apps/ui` (dev server :5874 віддає `apps/ui/dist`), ручний прогін.

## Відкинуто з первинного списку

| sha | PR | Чому |
| --- | --- | --- |
| `b6a821b39f` | #28503 | скріншоти browser tools: browser tools у v4 нема |
| `5e5533973f` | #29059 | одна задача в кількох проєктах: 207 з 467 рядків про Linear, Jira, incident.io; для GitHub і GitLab цінність мала |
| `b4fdcf59a5` | #29132 | плани там, де UI їх показує: основна зміна в `mastracode/sdk` (у нас це `@mastra/code-sdk@1.15.0`), приходить з оновленням пакета. Claude Code пише плани в `plansDirectory` окремо |

Поза планом: Slack, Jira, Vertex AI, Knowledge, шаблони, CLI та решта 145 неперенесених комітів.

## Оцінка

| Етап | Комітів | Обсяг (без тестів і непідтримуваного) | Ризик |
| --- | --- | --- | --- |
| 1. Швидкі виправлення | 3 | ~0.7k рядків | низький |
| 2. Дошки | 3 | ~2.9k рядків | середній |
| 3. Розділення карток | 6 | ~3.3k рядків | високий: міграція даних |
| 4. UI | 3 | ~6.2k рядків | середній |
