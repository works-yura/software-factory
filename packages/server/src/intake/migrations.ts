/**
 * One-off data moves for intake rules when a board renames or drops phases. A rule's action config
 * is opaque to the store, so the move reads the `create-card` shape here, next to the wiring that
 * registers that action.
 */

import type { IntakeRulesStorage } from '@factory/store';

/** The actor stamped on rules the Audits phase change rewrote. */
export const AUDITS_BOARD_UPGRADE_ACTOR = 'system:audits-board-phases';

/**
 * Points every `create-card` rule targeting `boardKey` at the renamed phase. Idempotent: a rule
 * already on a current phase is left alone. Returns how many rules moved.
 */
export async function renameIntakeRuleTargetPhases(
  rules: Pick<IntakeRulesStorage, 'listAll' | 'update'>,
  boardKey: string,
  renames: Readonly<Record<string, string>>,
  actor: string,
): Promise<number> {
  let moved = 0;
  for (const rule of await rules.listAll()) {
    if (rule.actionKind !== 'create-card' || rule.actionConfig.boardKey !== boardKey) continue;
    const phaseKey = rule.actionConfig.phaseKey;
    const renamed = typeof phaseKey === 'string' ? renames[phaseKey] : undefined;
    if (!renamed) continue;
    await rules.update(
      rule,
      rule.id,
      { actionConfig: { ...rule.actionConfig, phaseKey: renamed } },
      { expectedRevision: rule.revision, actor },
    );
    moved++;
  }
  return moved;
}
