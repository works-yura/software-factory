import { z } from 'zod';
import { describe, expect, it } from 'vitest';

import { IntakeConfigError, IntakeTargetError, IntakeUnknownKindError, intakeKinds } from '@factory/core';
import type {
  IntakeActionKind,
  IntakeEvent,
  IntakeEventListener,
  IntakeEventSource,
  IntakeFireSink,
  IntakePolicyKind,
  IntakeTriggerKind,
} from '@factory/core';
import type { IntakeRuleInput } from '@factory/store';
import { createFactoryStorageForTests } from '@factory/store/testing';

import { IntakeRuleEngine } from './engine.ts';
import { eventTriggerKind } from './event-trigger.ts';
import { alwaysPolicy } from './policies.ts';

const scope = { orgId: 'org-1', factoryProjectId: 'project-1' };

/** A trigger with no clock: the test fires it by hand through the sink the engine gave it. */
function manualTrigger() {
  let sink: IntakeFireSink | undefined;
  const armed = new Set<string>();
  const trigger: IntakeTriggerKind<{ path: string }> = {
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
  return { trigger, armed, fire: (...args: Parameters<IntakeFireSink>) => sink!(...args) };
}

function noteAction(notes: string[], problems: string[] = []): IntakeActionKind<{ text: string }> {
  return {
    kind: 'test-note',
    label: { uk: 'Нотатка', en: 'Note' },
    parse: config => ({ text: String((config as { text?: unknown }).text ?? '') }),
    describe: config => config.text,
    problems: async () => problems,
    run: async ({ config, fired, rule }) => {
      notes.push(`${rule.name}: ${config.text} #${String(fired.payload?.number)}`);
      return { workItemId: null };
    },
  };
}

/** A policy that lets every other fire through: proves policies are pluggable too. */
function everyOtherPolicy(): IntakePolicyKind {
  let count = 0;
  return {
    kind: 'test-every-other',
    label: { uk: 'Через раз', en: 'Every other' },
    decide: async () => (count++ % 2 === 0 ? { go: true } : { go: false, reason: 'odd fire' }),
  };
}

async function setup(kinds: Parameters<typeof intakeKinds>[0]) {
  const { intakeRules } = await createFactoryStorageForTests();
  const engine = new IntakeRuleEngine({ rules: intakeRules, kinds: intakeKinds(kinds), logger: { warn: () => {} } });
  await engine.start();
  const create = async (input: Partial<IntakeRuleInput>) => {
    const rule = await intakeRules.create(
      scope,
      {
        name: 'PR merged',
        triggerKind: 'test-webhook',
        triggerConfig: { path: '/hooks/pr' },
        actionKind: 'test-note',
        actionConfig: { text: 'release notes' },
        policyKind: 'always',
        enabled: true,
        ...input,
      },
      'admin-1',
    );
    await engine.validate(rule, scope);
    await engine.sync(rule);
    return rule;
  };
  return { engine, intakeRules, create };
}

describe('IntakeRuleEngine', () => {
  it('runs any registered trigger, policy and action through fire → policy → action → record', async () => {
    const manual = manualTrigger();
    const notes: string[] = [];
    const { engine, intakeRules, create } = await setup({
      triggers: [manual.trigger],
      actions: [noteAction(notes)],
      policies: [alwaysPolicy, everyOtherPolicy()],
    });
    const rule = await create({ policyKind: 'test-every-other' });
    expect(manual.armed.has(rule.id)).toBe(true);

    for (const number of [1, 2, 3]) {
      await manual.fire({ ruleId: rule.id, firedAt: new Date(number * 1000), triggerKind: 'test-webhook', payload: { number } });
    }

    expect(notes).toEqual(['PR merged: release notes #1', 'PR merged: release notes #3']);
    expect((await intakeRules.listFires(scope, rule.id)).map(fire => fire.outcome)).toEqual(['done', 'skipped', 'done']);
    expect(await engine.inspect(rule, 'en')).toMatchObject({
      triggerSummary: 'POST /hooks/pr',
      actionSummary: 'release notes',
      policySummary: 'Every other',
      nextFires: [],
      problems: [],
      lastFire: { outcome: 'done' },
    });
  });

  it('acts once on a fire delivered twice with the same key', async () => {
    const manual = manualTrigger();
    const notes: string[] = [];
    const { intakeRules, create } = await setup({ triggers: [manual.trigger], actions: [noteAction(notes)], policies: [alwaysPolicy] });
    const rule = await create({});
    const fired = { ruleId: rule.id, firedAt: new Date(1000), triggerKind: 'test-webhook', fireKey: 'claim-1', payload: { number: 7 } };

    await manual.fire(fired);
    await manual.fire(fired);

    expect(notes).toEqual(['PR merged: release notes #7']);
    expect(await intakeRules.listFires(scope, rule.id)).toEqual([expect.objectContaining({ fireKey: 'claim-1', outcome: 'done' })]);
  });

  it('refuses a rule with typed errors: unknown kind, a config that does not fit, a target that cannot run', async () => {
    const manual = manualTrigger();
    const { engine } = await setup({
      triggers: [manual.trigger],
      actions: [noteAction([], ['Board "gone" is not installed.'])],
      policies: [alwaysPolicy],
    });
    const rule = {
      triggerKind: 'test-webhook',
      triggerConfig: { path: '/x' },
      actionKind: 'test-note',
      actionConfig: { text: 'x' },
      policyKind: 'always',
    };
    await expect(engine.validate({ ...rule, actionKind: 'nope' }, scope)).rejects.toBeInstanceOf(IntakeUnknownKindError);
    await expect(engine.validate({ ...rule, triggerConfig: {} }, scope)).rejects.toThrow(/path is required/);
    await expect(engine.validate(rule, scope)).rejects.toBeInstanceOf(IntakeTargetError);
  });

  it('records a fire whose action throws as failed instead of throwing', async () => {
    const manual = manualTrigger();
    const broken: IntakeActionKind<object> = {
      kind: 'test-note',
      label: { uk: 'Зламана', en: 'Broken' },
      parse: () => ({}),
      describe: () => 'broken',
      run: async () => {
        throw new Error('boom');
      },
    };
    const { intakeRules, create } = await setup({ triggers: [manual.trigger], actions: [broken], policies: [alwaysPolicy] });
    const rule = await create({});
    await manual.fire({ ruleId: rule.id, firedAt: new Date(1000), triggerKind: 'test-webhook' });
    expect(await intakeRules.listFires(scope, rule.id)).toEqual([expect.objectContaining({ outcome: 'failed', reason: 'boom' })]);
  });
});

describe('eventTriggerKind', () => {
  /** The event-stream port as a test double: what a provider adapter would publish into. */
  function eventBus() {
    const listeners = new Set<IntakeEventListener>();
    const source: IntakeEventSource = {
      subscribe: listener => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const publish = async (event: IntakeEvent) => {
      for (const listener of listeners) await listener(event);
    };
    return { source, publish, listeners };
  }

  it('fires the matching armed rules of the event’s project once per event id, with its facts as payload', async () => {
    const bus = eventBus();
    const merged = eventTriggerKind({
      kind: 'test-pr-merged',
      label: { uk: 'PR змерджено', en: 'PR merged' },
      source: bus.source,
      schema: z.object({ branch: z.string().min(1) }),
      describe: config => `PR merged into ${config.branch}`,
      matches: (config, event) => event.type === 'pull_request.merged' && event.facts.branch === config.branch,
    });
    const notes: string[] = [];
    const { intakeRules, create } = await setup({ triggers: [merged], actions: [noteAction(notes)], policies: [alwaysPolicy] });
    const rule = await create({ triggerKind: 'test-pr-merged', triggerConfig: { branch: 'main' } });
    expect(bus.listeners.size).toBe(1);

    const event = (id: string, branch: string, factoryProjectId = scope.factoryProjectId): IntakeEvent => ({
      id,
      type: 'pull_request.merged',
      scope: { orgId: scope.orgId, factoryProjectId },
      occurredAt: new Date('2026-11-16T10:00:00Z'),
      facts: { branch, number: 42 },
    });
    await bus.publish(event('evt-1', 'main'));
    await bus.publish(event('evt-1', 'main'));
    await bus.publish(event('evt-2', 'develop'));
    await bus.publish(event('evt-3', 'main', 'another-project'));

    expect(notes).toEqual(['PR merged: release notes #42']);
    expect(await intakeRules.listFires(scope, rule.id)).toEqual([
      expect.objectContaining({ triggerKind: 'test-pr-merged', fireKey: 'event:evt-1', outcome: 'done' }),
    ]);
  });
});
