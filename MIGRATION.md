# Міграція v3 → v4

Код переноситься з `v3/packages/factory/src` копією. Нове пишеться тільки на швах: порт, тестова обгортка, тип замість важкого імпорту. Кожен шов — окремий коміт і рядок нижче.

Перевірка кроку: `pnpm verify` (типи разом із тестами, тести, звірка кількості тестів з v3 за `migration/test-pairs.tsv`).

## Перенесено

| v3 | v4 |
| --- | --- |
| `boards/{define-board,registry,semantics,relocate,transition-policy}.ts`, `rules/{types,validation,resolve,event-rules}.ts` | `core/src/boards`, `core/src/rules` |
| `boards/{work,review,work-tool-rules,work-transition-policy}.ts`, `work-item-branch.ts` | `pipelines/src/{work,review,shared}` |
| `storage/domains/work-items/{base,board-version}.ts` | `store/src/work-items` |
| `storage/domains/audit/{base,actions,actors}.ts` | `store/src/audit` |
| `storage/domains/comments/{base,activity,actor,feed-context,schema}.ts` | `store/src/comments` |
| `rules/dispatch-errors.ts` | `store/src/dispatch-errors.ts` |
| `rules/{transition-service,dispatcher,decision-applicability,terminal-cleanup}.ts` | `runtime/src` |
| `session/run-audit.ts`, `skills/service.ts`, `routes/attention-providers.ts` | `runtime/src` |

## Шви

| Де | Що змінено | Чому |
| --- | --- | --- |
| `core` реєстр | нема вбудованих Work/Review | рушій не знає конкретних дошок; їх ставить `@factory/pipelines` |
| `runtime/src/test-support.ts` | обгортки `FactoryTransitionService`, `FactoryDecisionDispatcher`, `createFactoryStorageForTests` з `createPipelines()` | у v3 Work/Review підставлялись за замовчуванням |
| `store/src/testing.ts` | реєстр для термінальних фаз — параметр | сховище не знає дошок |
| `store` `WorkItemUpdateConflictError`, `ExternalWorkItemSource` | беруться з core | два класи ламали `instanceof` у `moveCardToBoard` |
| `core` `CardMoveStore.supersedeDecisionsForWorkItem` | `Promise<unknown>` замість `Promise<number>` | сховище повертає записи; рушій значення не читає |
| `core` коди відмови | один масив `FACTORY_RULE_REJECTION_CODES` | у v3 `approval_required` відкидала перевірка рішення |
| `runtime/src/audit-recorder.ts` | інтерфейс `record` замість `Pick<AuditDomain>` | `AuditDomain` тягне hono і маршрути |
| `runtime/src/harness-state.ts` | `HarnessSessionState` замість `MastraCodeState` | runtime лише передає стан; `@mastra/code-sdk` переїде в харнес |
| `runtime/src/skills/rescan.ts` | дві речі з `workspace.ts` | `workspace.ts` тягне GitHub і пісочниці; синхронізація з резолвером переїде в харнес |
| `runtime/src/run-end-report.ts` | лише типи звіту | доставка звіту йде через нотифікації Mastra, переїде в харнес |
| `store/src/supervisor-finding.ts` | копія типу знахідки | `WorkItemsStorage` зберігає знахідки; Supervisor ще не перенесено |
| `store/src/comments/actor.ts` | `{ userId }` замість `Pick<ChannelAccountLink>` | домен channel-identity ще не перенесено |
| класи помилок | поля замість параметрів-властивостей | `erasableSyntaxOnly`, щоб Node запускав `.ts` напряму |

## Борг тестів v3, знайдений тайпчеком

У v3 тести не тайпчекались. Виправлено, поведінку тестів не змінено:

- `dispatcher.test.ts`: `failDeferredDecision` з `error` замість `lastError`, без `now` і `failureCode`; моки `reportRunEnd` без результату; `DecisionAttentionProvider` без `boards`; `counts` без `userId`.
- `transition-service.test.ts`, `terminal-cleanup.test.ts`, `run-audit.test.ts`, `comments/base.test.ts`, `work-items/base.test.ts`: неточні типи фікстур.
- `pipelines` тести: `'issue'` замість `'github-issue'`, `id` замість `bindingId` в актора.

## Далі

Порядок і обсяг — у `README.md`, розділ «Що далі».
