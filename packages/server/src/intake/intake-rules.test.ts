import { describe, expect, it } from 'vitest';

import { IntakeConfigError, INTAKE_RULE_METADATA_KEY } from '@factory/core';
import type { IntakeActionKind, IntakeRoute, IntakeTriggerKind } from '@factory/core';
import { createBoardRegistry, createFactoryStorageForTests, FactoryTransitionService } from '@factory/testing';
import type { IntakeRuleInput, IntakeRuleRecord } from '@factory/store';

import { intakeRuleScheduleId, INTAKE_RULE_FIRE_WORKFLOW_ID } from './schedule-trigger.ts';
import type { ScheduleRows } from './schedule-trigger.ts';
import { setupIntakeRules } from './setup.ts';

/** Core `Schedules` as far as the trigger uses it: rows in a map. */
function fakeSchedules() {
  const rows = new Map<string, Record<string, unknown>>();
  const schedules = {
    get: async (id: string) => (rows.get(id) as never) ?? null,
    create: async (input: Record<string, unknown>) => {
      const row = { ...input, status: input.status ?? 'active' };
      rows.set(input.id as string, row);
      return row as never;
    },
    update: async (id: string, patch: Record<string, unknown>) => {
      const row = { ...rows.get(id), ...patch };
      rows.set(id, row);
      return row as never;
    },
    pause: async (id: string) => rows.set(id, { ...rows.get(id), status: 'paused' }).get(id) as never,
    resume: async (id: string) => rows.set(id, { ...rows.get(id), status: 'active' }).get(id) as never,
    delete: async (id: string) => void rows.delete(id),
  } satisfies ScheduleRows;
  return { rows, schedules };
}

async function setup(
  options: { extraTriggers?: IntakeTriggerKind<any>[]; extraActions?: IntakeActionKind<any>[]; routes?: IntakeRoute[] } = {},
) {
  const seed = await createFactoryStorageForTests();
  const project = await seed.projects.create({ orgId: 'org-1', userId: 'admin-1', input: { name: 'Syncta' } });
  const scope = { orgId: 'org-1', factoryProjectId: project.id };
  const boards = createBoardRegistry();
  const transitionService = new FactoryTransitionService({ storage: seed.workItems, configVersion: 'test-v1', boards });
  let clock = new Date('2026-11-16T06:00:00Z');
  const { rows, schedules } = fakeSchedules();
  const audits: unknown[] = [];
  const { engine, workflows, kinds } = setupIntakeRules({
    rules: seed.intakeRules,
    now: () => clock,
    logger: { warn: () => {} },
    schedule: { schedules: () => schedules, now: () => clock },
    cards: {
      workItems: seed.workItems,
      boards: { load: async () => boards },
      intakeRoutes: { listIntakeRoutes: async () => options.routes ?? [] },
      transitionService: () => transitionService,
      auditRecorder: { record: async input => (audits.push(input), null) },
    },
    extra: { triggers: options.extraTriggers ?? [], actions: options.extraActions ?? [] },
  });
  await engine.start();
  const create = async (overrides: Partial<IntakeRuleInput> = {}, { validate = true } = {}) => {
    const input: IntakeRuleInput = {
      name: 'Security audit',
      triggerKind: 'schedule',
      triggerConfig: { spec: { preset: 'weekly', time: '08:00', weekday: 1 }, timezone: 'Europe/Kyiv' },
      actionKind: 'create-card',
      actionConfig: {
        boardKey: 'audits',
        phaseKey: 'analysis',
        titleTemplate: 'Аудит безпеки — {date}',
        description: 'Аудит: security. Rule {rule}, fired {date} {time}.',
        repository: null,
      },
      policyKind: 'skip-if-open',
      enabled: true,
      ...overrides,
    };
    if (validate) await engine.validate(input, scope);
    const rule = await seed.intakeRules.create(scope, input, 'admin-1');
    await engine.sync(rule);
    return rule;
  };
  /** Runs the fire workflow the way core's scheduler does when the rule's row comes due. */
  const fireSchedule = async (rule: IntakeRuleRecord, claimId?: string) => {
    const row = rows.get(intakeRuleScheduleId(rule.id));
    if (!row) throw new Error('no schedule row');
    const workflow = workflows[INTAKE_RULE_FIRE_WORKFLOW_ID]!;
    // The scheduler starts each fire's run under its claim id.
    const run = await workflow.createRun(claimId ? { runId: claimId } : undefined);
    const result = await run.start({ inputData: row.inputData as { ruleId: string } });
    expect(result.status).toBe('success');
    const [fire] = await seed.intakeRules.listFires(scope, rule.id, { limit: 1 });
    return fire!;
  };
  return {
    seed,
    scope,
    engine,
    kinds,
    rows,
    audits,
    transitionService,
    create,
    fireSchedule,
    setClock: (at: string) => (clock = new Date(at)),
  };
}

describe('intake rules: a schedule files Audits cards', () => {
  it('arms a core schedule row per rule, follows edits, and removes it when paused', async () => {
    const { engine, rows, seed, scope, create } = await setup();
    const rule = await create();
    expect(rows.get(intakeRuleScheduleId(rule.id))).toMatchObject({
      workflowId: INTAKE_RULE_FIRE_WORKFLOW_ID,
      cron: '0 8 * * 1',
      timezone: 'Europe/Kyiv',
      inputData: { ruleId: rule.id },
    });

    const daily = await seed.intakeRules.update(
      scope,
      rule.id,
      { triggerConfig: { spec: { preset: 'daily', time: '09:30' }, timezone: 'Europe/Kyiv' } },
      { expectedRevision: 1, actor: 'admin-1' },
    );
    await engine.sync(daily);
    expect(rows.get(intakeRuleScheduleId(rule.id))).toMatchObject({ cron: '30 9 * * *' });

    const paused = await seed.intakeRules.update(scope, rule.id, { enabled: false }, { expectedRevision: 2, actor: 'admin-1' });
    await engine.sync(paused);
    expect(rows.has(intakeRuleScheduleId(rule.id))).toBe(false);
  });

  it('files a card on the board in the configured phase, dated in the rule’s timezone, and records it', async () => {
    const { seed, scope, create, fireSchedule, setClock, audits } = await setup();
    const rule = await create();
    setClock('2026-11-16T22:30:00Z'); // already Tuesday in Kyiv

    const fire = await fireSchedule(rule);

    expect(fire).toMatchObject({ outcome: 'done', triggerKind: 'schedule', reason: null });
    const card = await seed.workItems.get({ orgId: 'org-1', id: fire.workItemId! });
    expect(card).toMatchObject({ board: 'audits', stages: ['analysis'], title: 'Аудит безпеки — 2026-11-17' });
    expect(card!.metadata).toMatchObject({
      description: 'Аудит: security. Rule Security audit, fired 2026-11-17 00:30.',
      [INTAKE_RULE_METADATA_KEY]: {
        id: rule.id,
        name: 'Security audit',
        triggerKind: 'schedule',
        firedAt: '2026-11-16T22:30:00.000Z',
        fireKey: expect.stringMatching(/^schedule:/),
      },
    });
    expect(card!.stageHistory.map(entry => entry.stage)).toEqual(['intake', 'analysis']);
    expect(fire.fireKey).toBe(card!.metadata![INTAKE_RULE_METADATA_KEY] && (card!.metadata![INTAKE_RULE_METADATA_KEY] as { fireKey: string }).fireKey);
    expect(audits).toContainEqual(
      expect.objectContaining({ action: 'factory.work_item.created', actorType: 'system', actorId: `factory-intake-rule:${rule.id}` }),
    );
    expect(scope.factoryProjectId).toBe(card!.factoryProjectId);
  });

  it('skips a fire while the last card is open and files again once it is done', async () => {
    const { seed, create, fireSchedule, transitionService, scope, setClock } = await setup();
    const rule = await create();
    const first = await fireSchedule(rule);

    setClock('2026-11-23T06:00:00Z');
    const skipped = await fireSchedule(rule);
    expect(skipped).toMatchObject({ outcome: 'skipped', workItemId: null });
    expect(skipped.reason).toMatch(/still open/);

    let card = (await seed.workItems.get({ orgId: 'org-1', id: first.workItemId! }))!;
    for (const stage of ['done']) {
      const moved = await transitionService.transition({
        ...scope,
        workItemId: card.id,
        board: 'audits',
        stage,
        expectedRevision: card.revision,
        actor: { type: 'human', id: 'admin-1' },
        ingress: { type: 'human', identity: `test:${stage}` },
        cause: 'test',
      });
      expect(moved.status).toBe('accepted');
      card = (await seed.workItems.get({ orgId: 'org-1', id: card.id }))!;
    }

    setClock('2026-11-30T06:00:00Z');
    const again = await fireSchedule(rule);
    expect(again).toMatchObject({ outcome: 'done' });
    expect(again.workItemId).not.toBe(first.workItemId);
  });

  it('lets an intake route on rule cards place the card, ahead of the rule’s own target', async () => {
    const route = (id: string, value: string, field = 'source.kind'): IntakeRoute => ({
      id,
      enabled: true,
      on: ['work_item.created'],
      when: { operator: 'AND', conditions: [{ field, operator: 'equals', value }] },
      target: { boardKey: 'work', phaseKey: null },
    });
    // Routes for other sources leave the card to the rule's default (Audits › Analysis).
    const unmatched = await setup({ routes: [route('prs', 'pull_request')] });
    const defaultFire = await unmatched.fireSchedule(await unmatched.create());
    expect(await unmatched.seed.workItems.get({ orgId: 'org-1', id: defaultFire.workItemId! })).toMatchObject({
      board: 'audits',
      stages: ['analysis'],
    });

    // A route on rule cards wins and stamps itself on the card, like any routed card.
    const routed = await setup({ routes: [route('rules', 'intake_rule'), route('by-trigger', 'schedule', 'intake.trigger')] });
    const fire = await routed.fireSchedule(await routed.create());
    const card = await routed.seed.workItems.get({ orgId: 'org-1', id: fire.workItemId! });
    expect(card).toMatchObject({ board: 'work', stages: ['intake'] });
    expect(card!.metadata).toMatchObject({ intakeRouteId: 'rules' });
  });

  it('acts once on a fire delivered twice under the same claim', async () => {
    const { seed, scope, create, fireSchedule } = await setup();
    const rule = await create({ policyKind: 'always' });
    const first = await fireSchedule(rule, 'claim-1');
    const again = await fireSchedule(rule, 'claim-1');
    expect(again.id).toBe(first.id);
    expect(await seed.intakeRules.listFires(scope, rule.id)).toHaveLength(1);
    const cards = (await seed.workItems.listShared(scope)).filter(card => card.board === 'audits');
    expect(cards).toHaveLength(1);
  });

  it('files one card when the action is retried after it made the card but before the fire was recorded', async () => {
    const { seed, scope, create, kinds } = await setup();
    const rule = await create();
    const action = kinds.actions.get('create-card')!;
    const run = () =>
      action.run({
        rule,
        config: action.parse(rule.actionConfig),
        fired: { ruleId: rule.id, firedAt: new Date('2026-11-16T06:00:00Z'), triggerKind: 'schedule', fireKey: 'schedule:claim-9' },
      });
    const first = await run();
    const retried = await run();
    expect(retried.workItemId).toBe(first.workItemId);
    expect((await seed.workItems.listShared(scope)).filter(card => card.board === 'audits')).toHaveLength(1);
  });

  it('records a fire it cannot carry out as failed, with the reason, instead of throwing', async () => {
    const { create, fireSchedule } = await setup();
    // Saved while the board existed; it has gone since.
    const rule = await create(
      { actionConfig: { boardKey: 'gone', phaseKey: null, titleTemplate: 'x', description: '', repository: null } },
      { validate: false },
    );
    const fire = await fireSchedule(rule);
    expect(fire).toMatchObject({ outcome: 'failed', workItemId: null });
    expect(fire.reason).toMatch(/Board "gone" is not installed/);
  });

  it('shows a schedule in words with its next fires', async () => {
    const { engine } = await setup();
    expect(
      engine.preview('schedule', { spec: { preset: 'weekdays', time: '14:18' }, timezone: 'Europe/Kyiv' }, 'uk'),
    ).toEqual({
      summary: 'У будні о 14:18 (Europe/Kyiv)',
      // 2026-11-16 is a Monday; Kyiv is UTC+2 in November.
      nextFires: [new Date('2026-11-16T12:18:00.000Z'), new Date('2026-11-17T12:18:00.000Z'), new Date('2026-11-18T12:18:00.000Z')],
      problems: [],
    });
    expect(engine.preview('schedule', { spec: { preset: 'daily', time: '25:00' }, timezone: 'UTC' }, 'en').problems).toEqual([
      expect.stringMatching(/HH:MM/),
    ]);
    expect(engine.preview('schedule', { spec: { preset: 'cron', cron: 'not a cron' }, timezone: 'UTC' }, 'en').problems).toHaveLength(1);
  });
});
