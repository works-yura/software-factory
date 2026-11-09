import { codeBoardOf, factoryLaneForRole, LEGACY_PLAN_ROLE } from '@factory/core';
import type { InstalledBoard } from '@factory/core';

import { workBoard } from './board.ts';

/*
 * Compatibility for the Work board's old `plan` role; see `@factory/core`'s
 * `legacy-plan-role.ts`. Only the built-in Work board, as code defines it or as
 * a project edited it, gets these rules. A board installed as `work` in place of
 * it is matched by its own contexts, like any other board.
 */

/** Skills Planning runs. */
const PLANNING_SKILLS: ReadonlySet<string> = new Set(['factory-plan']);

function isWorkBoard(board: unknown): board is InstalledBoard {
  return typeof board === 'object' && board !== null && codeBoardOf(board) === workBoard;
}

/** The built-in Work lane a role's run belongs to: `plan` plans, `work` builds. Undefined on other boards. */
export function workLaneForRole(board: unknown, role: string): string | undefined {
  return isWorkBoard(board) ? factoryLaneForRole(role) : undefined;
}

/**
 * Whether a built-in Work stage carries a run decided for `role`. Planning,
 * Building and Review share the `work` context, so the skill tells them apart:
 * Planning carries the plan skills' runs (and runs for the old `plan` role),
 * Building and Review the other `work` runs. Undefined on other boards.
 */
export function workStageCarries(board: unknown, stage: string, role: string, skillName: unknown): boolean | undefined {
  if (!isWorkBoard(board)) return undefined;
  if (role === LEGACY_PLAN_ROLE) return stage === 'planning';
  if (role !== 'work') return board.roleForPhase(stage) === role;
  if (board.roleForPhase(stage) !== 'work') return false;
  return (stage === 'planning') === (typeof skillName === 'string' && PLANNING_SKILLS.has(skillName));
}
