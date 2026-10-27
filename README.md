# v4

Окреме дерево поруч із `v3`, на один рівень вище. `v3` лишається довідником і не імпортує ці пакети.

| Пакет | Тека | Що це |
| --- | --- | --- |
| `@factory/core` | `packages/core` | Рушій дошок: `defineBoard`, `createBoardRegistry`, семантика фаз, перевірка рішення, перенесення картки |
| `@factory/pipelines` | `packages/pipelines` | Дошки Work, Review і Acceptance. Залежить від `@factory/core`; рушій їх не імпортує |
| `@factory/store` | `packages/store` | Сховища карток, аудиту й коментарів з v3 на сховищі Mastra (libsql або pg). `@factory/store/testing` — libsql `:memory:` для тестів |
| `@factory/platform` | `packages/platform` | Решта v3 одним пакетом: інтеграції, маршрути, сесії, інструменти, пісочниці, Supervisor, `MastraFactory`. Пакети виносяться з нього по одному |
| `@internal/workspace` | `packages/internal-workspace` | Файлові команди, клонування репо, маркер setup (з v3) |
| `@factory/runtime` | `packages/runtime` | Сервіс переходів, диспетчер рішень, аудит запусків, термінальне прибирання з v3. Mastra лише в типах сесії та `RequestContext` |

Хост ставить дошки так:

```ts
import { createPipelines } from '@factory/pipelines';

const boards = createPipelines();
```

Реєстр без Work і Review: `createBoardRegistry({ boards: [...] })` з `@factory/core`.

У `@factory/pipelines` кожна дошка має свою теку однакової форми:

```
<board>/
  board.ts               фази, переходи, підключення правил
  phase-rules.ts         onEnter: яку сесію агента запустити
  transition-policy.ts   хто і куди може перенести картку
  tool-rules.ts          реакція на результат інструмента агента (лише Work)
shared/work-item-branch.ts   назви гілок і номери PR/MR для Work і Review
```

Нова дошка — нова тека й один рядок у `createPipelines`.

## Збірка

Збірки нема. Пакети експортують `src/index.ts`, імпорти всередині мають розширення `.ts`, синтаксис лише той, що стирається (`erasableSyntaxOnly`). Node ≥ 22.18 запускає код напряму, `tsc` з `rewriteRelativeImportExtensions` перепише імпорти, якщо колись знадобиться emit.

```sh
pnpm check   # tsc --noEmit, разом із тестами
pnpm test    # vitest
```

## Що далі

Код переноситься з v3 копією, тести — 1:1 (`pnpm verify` звіряє кількість). Нове пишеться лише на швах. Журнал — `MIGRATION.md`.

Уся функціональність v3 уже у v4. Далі пакети виносяться з `@factory/platform`, знизу вгору:

1. `capabilities`, `sandbox`, `environment`.
2. Порт харнесу і `@factory/harness-mastra` (координатор старту, процесор, `session/*`, `workspace.ts`, `tools`, `mcp`).
3. `integrations` (`base`, потім GitLab, GitHub, решта).
4. `supervisor`, `auth`, `api` (`routes`), складання `MastraFactory` → `apps/server`.
5. `apps/ui`.
6. Звузити сховище до портів, потім адаптер Firestore.
