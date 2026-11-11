import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/** The workspace's `packages/` directory: every package's `src` is scanned. */
const PACKAGES = fileURLToPath(new URL('../../../', import.meta.url));

/** Work's seed and the readers of rows written before other boards existed. */
const SEED_AND_LEGACY = new Set([
  'pipelines/src/work/board.ts',
  'pipelines/src/work/legacy-plan-role.ts',
  // Work as projects stored it while it had its `review` self-review phase (upstream #29724).
  'pipelines/src/work/legacy-self-review.ts',
  // Work as projects stored it while it had Triage (upstream #29901).
  'pipelines/src/work/legacy-triage.ts',
  'core/src/boards/legacy-plan-role.ts',
  'store/src/boards/work-routes.ts',
  'store/src/work-items/legacy-keys.ts',
  'runtime/src/work-migrations.ts',
]);

/** Lines that match a pattern but name something other than a Work board or phase. */
const NOT_PHASES: readonly [file: string, line: string, why: string][] = [
  ['api/src/metrics.ts', "includes('canceled')", 'a metrics outcome'],
  ['harness-mastra/src/tools/reports.ts', "['done', 'failed']", 'run report statuses'],
  ['core/src/boards/define-board.ts', "keys.includes('canceled')", "the keys of a board's sourceClosed"],
  ['integration-github/src/routes.ts', "GithubIntegration['intake']", 'the intake API of the integration'],
  ['pipelines/src/product/board.ts', "initialPhase: 'intake'", "the Product board's own Intake phase"],
  ['pipelines/src/product/board.ts', "nextPhases: ['intake']", "the Product board's own Intake phase"],
  ['pipelines/src/audits/board.ts', "initialPhase: 'intake'", "the Audits board's own Intake phase"],
  ['pipelines/src/audits/board.ts', "nextPhases: ['done', 'canceled']", "the Audits board's own phases"],
  ['pipelines/src/audits/board.ts', "nextPhases: ['intake']", "the Audits board's own Intake phase"],
  ['core/src/intake/rule.ts', "INTAKE_FIRE_OUTCOMES = ['done'", "a trigger route fire's outcome"],
  ['integration-clickup/src/integration.ts', "requiredDomains = ['intake'", 'storage domain names, not phases'],
  // v4 retired the Review board itself (2fa2fed): these migrations rewrite its rows onto Work.
  ['store/src/boards/base.ts', "board_key: 'review'", 'Review board retirement migration'],
  ['store/src/boards/base.ts', "board_key !== 'review'", 'Review board retirement migration'],
  ['store/src/boards/base.ts', "board_key: 'work'", 'Review board retirement migration'],
  ['store/src/boards/base.ts', "=== 'review' ? 'pr-review'", 'Review board retirement migration'],
  ['store/src/intake/base.ts', "board: 'review'", 'Review board retirement migration'],
  ['store/src/intake/base.ts', "board: 'work'", 'Review board retirement migration'],
  ['store/src/work-items/base.ts', "row.board === 'review'", 'Review board retirement migration'],
  ['store/src/work-items/base.ts', "=== 'review' ? 'pr-review'", 'Review board retirement migration'],
  ['store/src/work-items/base.ts', "board: 'work'", 'Review board retirement migration'],
];

/**
 * v4 code that still reads Work by its keys. Each is debt to move onto the board's phases
 * (`boardFlow`); the list only shrinks, so new code can't add another.
 */
const V4_WORK_KEY_DEBT: readonly [file: string, line: string][] = [
  ['core/src/boards/semantics.ts', "stage === 'done' || stage === 'canceled'"],
  ['harness-mastra/src/rules/product-tools.ts', "board: 'work'"],
  ['harness-mastra/src/rules/tools.ts', "role === 'triage'"],
  ['harness-mastra/src/rules/work-item-state-processor.ts', "boardId !== 'work'"],
  ['runtime/src/attention-providers.ts', "board: 'work'"],
  ['server/src/claude/bound-tools.ts', "item.board ?? 'work'"],
  ['server/src/claude/plan-approval.ts', "board: 'work'"],
  ['server/src/claude/plan-approval.ts', "stage: 'execute'"],
  ['server/src/claude/start-coordinator.ts', "destinationStage === 'planning'"],
  ['supervisor/src/acceptance.ts', "new Set(['planning', 'execute', 'review'])"],
  ['supervisor/src/acceptance.ts', "stage === 'intake' || stage === 'triage'"],
  ['supervisor/src/health.ts', "=== 'work' && stage === 'planning'"],
];

const KEYS = 'work|review|pr-review|planning|execute|intake|triage|done|canceled';
const PATTERNS = [
  // board === 'work', stage: 'done', role ?? 'work', ...
  new RegExp(
    `\\b(board|boardId|stage|stages|phase|phaseKey|role|lane|destinationStage|initialPhase)\\w*\\??\\s*(===|!==|:|=|\\?\\?)\\s*['"\`](${KEYS})['"\`]`,
  ),
  new RegExp(`['"\`](${KEYS})['"\`]\\s*(===|!==)\\s*\\w*(board|stage|phase|role)`),
  new RegExp(`\\.(includes|has)\\(\\s*['"\`](${KEYS})['"\`]\\s*\\)`),
  /\[\s*['"`](intake|triage|planning|execute|pr-review|done|canceled)['"`]\s*[,\]]/,
  /['"`]pr-review['"`]/,
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' || entry.name === 'node_modules' ? [] : sourceFiles(path);
    return /\.tsx?$/.test(entry.name) &&
      !/\.test\.tsx?$/.test(entry.name) &&
      entry.name !== 'test-utils.ts' &&
      entry.name !== 'testing.ts'
      ? [path]
      : [];
  });
}

function packageSources(): string[] {
  return readdirSync(PACKAGES, { withFileTypes: true }).flatMap(entry => {
    if (!entry.isDirectory()) return [];
    const src = join(PACKAGES, entry.name, 'src');
    return existsSync(src) ? sourceFiles(src) : [];
  });
}

describe("Factory's runtime", () => {
  it("reads no board or phase by Work's keys outside Work's seed and the legacy readers", () => {
    const found: string[] = [];
    for (const path of packageSources()) {
      const file = relative(PACKAGES, path);
      if (SEED_AND_LEGACY.has(file)) continue;
      readFileSync(path, 'utf8')
        .split('\n')
        .forEach((line, index) => {
          if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
          if (!PATTERNS.some(pattern => pattern.test(line))) return;
          if (NOT_PHASES.some(([allowed, text]) => allowed === file && line.includes(text))) return;
          if (V4_WORK_KEY_DEBT.some(([allowed, text]) => allowed === file && line.includes(text))) return;
          found.push(`${file}:${index + 1}: ${line.trim()}`);
        });
    }
    expect(found).toEqual([]);
  });

  it('lists no Work-key debt that is already paid off', () => {
    const sources = new Map(packageSources().map(path => [relative(PACKAGES, path), readFileSync(path, 'utf8')]));
    const paid = V4_WORK_KEY_DEBT.filter(([file, text]) => !sources.get(file)?.includes(text));
    expect(paid).toEqual([]);
  });
});
