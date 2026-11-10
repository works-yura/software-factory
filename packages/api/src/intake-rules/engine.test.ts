import { describe, expect, it } from 'vitest';

import { createBoardRegistry, createFactoryStorageForTests, FactoryTransitionService } from '@factory/testing';
import type { IntakeRuleInput, IntakeRuleRecord } from '@factory/store';

import { INTAKE_RULE_METADATA_KEY } from './create-card-action.ts';
import { setupIntakeRules } from './index.ts';
import { IntakeConfigError } from './kinds.ts';
import type { IntakeActionKind, IntakeFireSink, IntakeTriggerKind } from './kinds.ts';
import { intakeRuleScheduleId, INTAKE_RULE_FIRE_WORKFLOW_ID } from './schedule-trigger.ts';
import type { ScheduleRows } from './schedule-trigger.ts';

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

async function setup(options: { extraTriggers?: IntakeTriggerKind<any>[]; extraActions?: IntakeActionKind<any>[] } = {}) {
  const seed = await createFactoryStorageForTests();
  const project = await seed.projects.create({ orgId: 'org-1', userId: 'admin-1', input: { name: 'Syncta' } });
  const scope = { orgId: 'org-1', factoryProjectId: project.id };
  const boards = createBoardRegistry();
  const transitionService = new FactoryTransitionService({ storage: seed.workItems, configVersion: 'test-v1', boards });
  let clock = new Date('2026-11-16T06:00:00Z');
  const { rows, schedules } = fakeSchedules();
  const audits: unknown[] = [];
  const { engine, workflows } = setupIntakeRules({
    rules: seed.intakeRules,
    now: () => clock,
    logger: { warn: () => {} },
    schedule: { schedules: () => schedules, now: () => clock },
    cards: {
      workItems: seed.workItems,
      boards: { load: async () => boards },
      transitionService: () => transitionService,
      auditRecorder: { record: async input => (audits.push(input), null) },
    },
    extra: { triggers: options.extraTriggers ?? [], actions: options.extraActions ?? [] },
  });
  await engine.start();
  const create = async (overrides: Partial<IntakeRuleInput> = {}) => {
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
    engine.validate(input);
    const rule = await seed.intakeRules.create(scope, input, 'admin-1');
    await engine.sync(rule);
    return rule;
  };
  /** Runs the fire workflow the way core's scheduler does when the rule's row comes due. */
  const fireSchedule = async (rule: IntakeRuleRecord) => {
    const row = rows.get(intakeRuleScheduleId(rule.id));
    if (!row) throw new Error('no schedule row');
    const workflow = workflows[INTAKE_RULE_FIRE_WORKFLOW_ID]!;
    const run = await workflow.createRun();
    const result = await run.start({ inputData: row.inputData as { ruleId: string } });
    expect(result.status).toBe('success');
    const [fire] = await seed.intakeRules.listFires(scope, rule.id, { limit: 1 });
    return fire!;
  };
  return {
    seed,
    scope,
    engine,
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
      [INTAKE_RULE_METADATA_KEY]: { id: rule.id, name: 'Security audit', firedAt: '2026-11-16T22:30:00.000Z' },
    });
    expect(card!.stageHistory.map(entry => entry.stage)).toEqual(['scheduled', 'analysis']);
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
    for (const stage of ['report', 'done']) {
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

  it('records a fire it cannot carry out as failed, with the reason, instead of throwing', async () => {
    const { create, fireSchedule } = await setup();
    const rule = await create({
      actionConfig: { boardKey: 'gone', phaseKey: null, titleTemplate: 'x', description: '', repository: null },
    });
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
      nextFires: ['2026-11-16T12:18:00.000Z', '2026-11-17T12:18:00.000Z', '2026-11-18T12:18:00.000Z'],
      problems: [],
    });
    expect(engine.preview('schedule', { spec: { preset: 'daily', time: '25:00' }, timezone: 'UTC' }, 'en').problems).toEqual([
      expect.stringMatching(/HH:MM/),
    ]);
    expect(engine.preview('schedule', { spec: { preset: 'cron', cron: 'not a cron' }, timezone: 'UTC' }, 'en').problems).toHaveLength(1);
  });
});

describe('intake rules: new kinds plug into the same engine', () => {
  it('runs a registered trigger kind and action kind through fire → policy → action → record', async () => {
    let sink: IntakeFireSink | undefined;
    const armed = new Set<string>();
    const webhook: IntakeTriggerKind<{ path: string }> = {
      kind: 'test-webhook',
      label: { uk: 'Вебхук', en: 'Webhook' },
      parse: config => {
        const path = (config as { path?: unknown }).path;
        if (typeof path !== 'string') throw new IntakeConfigError('path is required');
        return { path };
      },
      describe: config => `POST ${config.path}`,
      start: next => {
        sink = next;
      },
      arm: async rule => void armed.add(rule.id),
      disarm: async ruleId => void armed.delete(ruleId),
    };
    const notes: string[] = [];
    const note: IntakeActionKind<{ text: string }> = {
      kind: 'test-note',
      label: { uk: 'Нотатка', en: 'Note' },
      parse: config => ({ text: String((config as { text?: unknown }).text ?? '') }),
      describe: config => config.text,
      run: async ({ config, fired, rule }) => {
        notes.push(`${rule.name}: ${config.text} #${String(fired.payload?.number)}`);
        return { workItemId: null };
      },
    };
    const { engine, create, seed, scope } = await setup({ extraTriggers: [webhook], extraActions: [note] });
    const rule = await create({
      name: 'PR merged',
      triggerKind: 'test-webhook',
      triggerConfig: { path: '/hooks/pr' },
      actionKind: 'test-note',
      actionConfig: { text: 'release notes' },
      policyKind: 'always',
    });
    expect(armed.has(rule.id)).toBe(true);

    await sink!({ ruleId: rule.id, firedAt: new Date('2026-11-16T10:00:00Z'), triggerKind: 'test-webhook', payload: { number: 42 } });

    expect(notes).toEqual(['PR merged: release notes #42']);
    expect(await seed.intakeRules.listFires(scope, rule.id)).toEqual([
      expect.objectContaining({ outcome: 'done', triggerKind: 'test-webhook', workItemId: null }),
    ]);
    const presented = await engine.present(rule, 'en');
    expect(presented).toMatchObject({
      trigger: { kind: 'test-webhook', summary: 'POST /hooks/pr' },
      action: { kind: 'test-note', summary: 'release notes' },
      policy: { kind: 'always', summary: 'Always run' },
      nextFires: [],
      problems: [],
      lastFire: { outcome: 'done' },
    });
    expect(() => engine.validate({ ...rule, triggerConfig: {} })).toThrow(/path is required/);
    expect(() => engine.validate({ ...rule, actionKind: 'nope' })).toThrow(/Unknown action/);
  });
});
