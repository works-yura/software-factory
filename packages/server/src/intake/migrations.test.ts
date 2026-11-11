import { describe, expect, it } from 'vitest';

import { AUDITS_LEGACY_PHASE_RENAMES } from '@factory/pipelines';
import { createFactoryStorageForTests } from '@factory/store/testing';

import { AUDITS_BOARD_UPGRADE_ACTOR, renameIntakeRuleTargetPhases } from './migrations.ts';

const scope = { orgId: 'org-1', factoryProjectId: 'project-1' };

function cardRule(boardKey: string, phaseKey: string | null) {
  return {
    name: `${boardKey} ${phaseKey}`,
    triggerKind: 'schedule',
    triggerConfig: { spec: { preset: 'daily', time: '09:00' }, timezone: 'Europe/Kyiv' },
    actionKind: 'create-card',
    actionConfig: { boardKey, phaseKey, titleTemplate: 'Audit', description: '', repository: null },
    policyKind: 'skip-if-open',
    enabled: true,
  };
}

describe('renameIntakeRuleTargetPhases', () => {
  it("moves create-card rules off the Audits board's old phases, once, and leaves the rest", async () => {
    const { intakeRules } = await createFactoryStorageForTests();
    const scheduled = await intakeRules.create(scope, cardRule('audits', 'scheduled'), 'user-1');
    const report = await intakeRules.create(scope, cardRule('audits', 'report'), 'user-1');
    const current = await intakeRules.create(scope, cardRule('audits', 'analysis'), 'user-1');
    const other = await intakeRules.create(scope, cardRule('work', 'report'), 'user-1');

    const run = () => renameIntakeRuleTargetPhases(intakeRules, 'audits', AUDITS_LEGACY_PHASE_RENAMES, AUDITS_BOARD_UPGRADE_ACTOR);
    expect(await run()).toBe(2);
    expect(await run()).toBe(0);

    const phase = async (id: string) => (await intakeRules.get(scope, id))!.actionConfig.phaseKey;
    expect(await phase(scheduled.id)).toBe('intake');
    expect(await phase(report.id)).toBe('done');
    expect(await phase(current.id)).toBe('analysis');
    expect(await phase(other.id)).toBe('report');
    expect((await intakeRules.get(scope, report.id))!.updatedBy).toBe(AUDITS_BOARD_UPGRADE_ACTOR);
  });
});
