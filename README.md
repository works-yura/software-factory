# v4

Окреме дерево поруч із `v3`, на один рівень вище. `v3` лишається довідником і не імпортує ці пакети.

| Пакет | Тека | Що це |
| --- | --- | --- |
| `@factory/core` | `packages/core` | Рушій дошок: `defineBoard`, `createBoardRegistry`, семантика фаз, перевірка рішення, перенесення картки |
| `@factory/pipelines` | `packages/pipelines` | Дошки Work, Review і Acceptance. Залежить від `@factory/core`; рушій їх не імпортує |
| `@factory/store` | `packages/store` | Сховища карток, аудиту й коментарів з v3 на сховищі Mastra (libsql або pg). `@factory/store/testing` — libsql `:memory:` для тестів |
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

Код переноситься з v3 копією, тести — 1:1. Нове пишеться лише там, де треба розрізати залежність.

1. Винести з диспетчера сесію Mastra в порт харнесу: `FactoryController`, `DispatcherSession`, `RequestContext`, `skills/service.ts`.
2. `@factory/harness-mastra`: перший харнес, код з v3 (координатор старту, `AgentController`, процесор, інструменти).
3. Звузити `WorkItemsStorage` до портів (`CardStore`, `DecisionQueue`, `RunBindings`), прибрати з нього Supervisor, увагу й підписки. Потім адаптер Firestore.
