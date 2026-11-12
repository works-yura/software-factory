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
  IntakeRouteFire,
  IntakeTriggerKind,
  IntakeTriggerRoute,
  IntakeTriggerRouteRepository,
} from '@factory/core';

import { FIRE_LOCK_BUSY_REASON, IntakeTriggerEngine } from './engine.ts';
import type { IntakeTriggerEngineOptions } from './engine.ts';
import { eventTriggerKind } from './event-trigger.ts';
import { alwaysPolicy } from './policies.ts';

const scope = { orgId: 'org-1', factoryProjectId: 'project-1' };

/** The repository port as a test double: trigger routes and their fire log in memory. */
function memoryRoutes() {
  const routes = new Map<string, IntakeTriggerRoute>();
  const fires: IntakeRouteFire[] = [];
  const locks = new Map<string, { holder: string; until: number }>();
  const repository: IntakeTriggerRouteRepository = {
    getTriggerRoute: async id => routes.get(id) ?? null,
    listTriggerRoutes: async () => [...routes.values()],
    recordFire: async input => {
      const fire = { ...input, triggeredBy: input.triggeredBy ?? null, id: `fire-${fires.length + 1}` };
      fires.push(fire);
      return fire;
    },
    findFire: async (routeId, fireKey) => fires.find(fire => fire.routeId === routeId && fire.fireKey === fireKey) ?? null,
    listFires: async (_scope, routeId, options) =>
      fires
        .filter(fire => fire.routeId === routeId)
        .reverse()
        .slice(0, options?.limit ?? Infinity),
    lastDoneFire: async routeId => fires.filter(fire => fire.routeId === routeId && fire.outcome === 'done').at(-1) ?? null,
    claimFire: async (route, holder, until) => {
      const current = locks.get(route.id);
      if (current && current.holder !== holder && current.until > Date.now()) return false;
      locks.set(route.id, { holder, until: until.getTime() });
      return true;
    },
    releaseFire: async (route, holder) => {
      if (locks.get(route.id)?.holder === holder) locks.delete(route.id);
    },
  };
  return { routes, fires, locks, repository };
}

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
    arm: async route => void armed.add(route.id),
    disarm: async routeId => void armed.delete(routeId),
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
    run: async ({ config, fired, route }) => {
      notes.push(`${route.name} → ${route.target.boardKey}: ${config.text} #${String(fired.payload?.number)}`);
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

async function setup(kinds: Parameters<typeof intakeKinds>[0], fireLock?: IntakeTriggerEngineOptions['fireLock']) {
  const memory = memoryRoutes();
  const engine = new IntakeTriggerEngine({
    routes: memory.repository,
    kinds: intakeKinds(kinds),
    logger: { warn: () => {} },
    ...(fireLock ? { fireLock } : {}),
  });
  await engine.start();
  const add = async (overrides: Partial<IntakeTriggerRoute> = {}) => {
    const route: IntakeTriggerRoute = {
      ...scope,
      id: `route-${memory.routes.size + 1}`,
      name: 'PR merged',
      enabled: true,
      trigger: { kind: 'test-webhook', config: { path: '/hooks/pr' } },
      action: { kind: 'test-note', config: { text: 'release notes' } },
      policyKind: 'always',
      target: { boardKey: 'audits', phaseKey: null },
      revision: 1,
      createdBy: 'admin-1',
      ...overrides,
    };
    await engine.validate(route, scope);
    memory.routes.set(route.id, route);
    await engine.sync(route);
    return route;
  };
  return { engine, memory, add };
}

describe('IntakeTriggerEngine', () => {
  it('runs any registered trigger, policy and action of a route through fire → policy → action → record', async () => {
    const manual = manualTrigger();
    const notes: string[] = [];
    const { engine, memory, add } = await setup({
      triggers: [manual.trigger],
      actions: [noteAction(notes)],
      policies: [alwaysPolicy, everyOtherPolicy()],
    });
    const route = await add({ policyKind: 'test-every-other' });
    expect(manual.armed.has(route.id)).toBe(true);

    for (const number of [1, 2, 3]) {
      await manual.fire({ routeId: route.id, firedAt: new Date(number * 1000), triggerKind: 'test-webhook', payload: { number } });
    }

    expect(notes).toEqual(['PR merged → audits: release notes #1', 'PR merged → audits: release notes #3']);
    expect(memory.fires.map(fire => fire.outcome)).toEqual(['done', 'skipped', 'done']);
    expect(await engine.inspect(route, 'en')).toMatchObject({
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
    const { memory, add } = await setup({ triggers: [manual.trigger], actions: [noteAction(notes)], policies: [alwaysPolicy] });
    const route = await add();
    const fired = { routeId: route.id, firedAt: new Date(1000), triggerKind: 'test-webhook', fireKey: 'claim-1', payload: { number: 7 } };

    await manual.fire(fired);
    await manual.fire(fired);

    expect(notes).toEqual(['PR merged → audits: release notes #7']);
    expect(memory.fires).toEqual([expect.objectContaining({ fireKey: 'claim-1', outcome: 'done' })]);
  });

  it('refuses a route with typed errors: unknown kind, a config that does not fit, a target that cannot run', async () => {
    const manual = manualTrigger();
    const { engine } = await setup({
      triggers: [manual.trigger],
      actions: [noteAction([], ['Board "gone" is not installed.'])],
      policies: [alwaysPolicy],
    });
    const route = {
      trigger: { kind: 'test-webhook', config: { path: '/x' } },
      action: { kind: 'test-note', config: { text: 'x' } },
      policyKind: 'always',
      target: { boardKey: 'gone', phaseKey: null },
    };
    await expect(engine.validate({ ...route, action: { kind: 'nope', config: {} } }, scope)).rejects.toBeInstanceOf(
      IntakeUnknownKindError,
    );
    await expect(engine.validate({ ...route, trigger: { kind: 'test-webhook', config: {} } }, scope)).rejects.toThrow(
      /path is required/,
    );
    await expect(engine.validate(route, scope)).rejects.toBeInstanceOf(IntakeTargetError);
  });

  it('records a fire whose action throws as failed instead of throwing, and a paused route’s fire as skipped', async () => {
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
    const { memory, add } = await setup({ triggers: [manual.trigger], actions: [broken], policies: [alwaysPolicy] });
    const route = await add();
    await manual.fire({ routeId: route.id, firedAt: new Date(1000), triggerKind: 'test-webhook' });
    memory.routes.set(route.id, { ...route, enabled: false });
    await manual.fire({ routeId: route.id, firedAt: new Date(2000), triggerKind: 'test-webhook' });
    expect(memory.fires).toEqual([
      expect.objectContaining({ outcome: 'failed', reason: 'boom' }),
      expect.objectContaining({ outcome: 'skipped', reason: 'The route is switched off.' }),
    ]);
  });

  it('stops the trigger of a route that is gone and records nothing', async () => {
    const manual = manualTrigger();
    const { memory, add } = await setup({ triggers: [manual.trigger], actions: [noteAction([])], policies: [alwaysPolicy] });
    const route = await add();
    memory.routes.delete(route.id);
    await manual.fire({ routeId: route.id, firedAt: new Date(1000), triggerKind: 'test-webhook' });
    expect(manual.armed.has(route.id)).toBe(false);
    expect(memory.fires).toEqual([]);
  });

  it('fires a route by hand through the same policy, action and record, naming who started it', async () => {
    const manual = manualTrigger();
    const notes: string[] = [];
    const { engine, memory, add } = await setup({
      triggers: [manual.trigger],
      actions: [noteAction(notes)],
      policies: [alwaysPolicy, everyOtherPolicy()],
    });
    const route = await add({ policyKind: 'test-every-other' });
    const first = await engine.fireNow(route, 'admin-7');
    await manual.fire({ routeId: route.id, firedAt: new Date(2000), triggerKind: 'test-webhook', fireKey: 'claim-1' });
    expect(first).toMatchObject({
      outcome: 'done',
      triggerKind: 'test-webhook',
      triggeredBy: 'admin-7',
      fireKey: expect.stringMatching(/^manual:/),
    });
    // The policy counts the manual fire like any other: the trigger's next one is held back.
    expect(memory.fires.map(fire => [fire.outcome, fire.triggeredBy])).toEqual([
      ['done', 'admin-7'],
      ['skipped', null],
    ]);
    expect(notes).toHaveLength(1);
    expect(memory.locks.size).toBe(0);
  });

  it('runs one fire of a route at a time: the next waits for the lock, and one that waits too long is skipped', async () => {
    const manual = manualTrigger();
    let release: () => void = () => {};
    const running: string[] = [];
    const slow: IntakeActionKind<object> = {
      kind: 'test-note',
      label: { uk: 'Повільна', en: 'Slow' },
      parse: () => ({}),
      describe: () => 'slow',
      run: async ({ fired }) => {
        running.push(`start ${fired.fireKey}`);
        if (fired.fireKey === 'claim-1') await new Promise<void>(resolve => (release = resolve));
        running.push(`end ${fired.fireKey}`);
        return { workItemId: null };
      },
    };
    const { engine, memory, add } = await setup(
      { triggers: [manual.trigger], actions: [slow], policies: [alwaysPolicy] },
      { waitMs: 1_000, pollMs: 5 },
    );
    const route = await add();
    const scheduled = manual.fire({ routeId: route.id, firedAt: new Date(1000), triggerKind: 'test-webhook', fireKey: 'claim-1' });
    await new Promise(resolve => setTimeout(resolve, 20));
    const byHand = engine.fireNow(route, 'admin-7');
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(running).toEqual(['start claim-1']);
    release();
    await scheduled;
    const fire = await byHand;
    expect(running).toEqual(['start claim-1', 'end claim-1', `start ${fire!.fireKey}`, `end ${fire!.fireKey}`]);

    // A lock held past the wait (another replica's fire still running): skipped, said why.
    expect(memory.locks.size).toBe(0);
    const quick = await setup({ triggers: [manualTrigger().trigger], actions: [slow], policies: [alwaysPolicy] }, { waitMs: 30, pollMs: 5 });
    quick.memory.routes.set(route.id, route);
    quick.memory.locks.set(route.id, { holder: 'replica-2', until: Date.now() + 60_000 });
    expect(await quick.engine.fireNow(route, 'admin-7')).toMatchObject({ outcome: 'skipped', reason: FIRE_LOCK_BUSY_REASON });
    // An expired lock (its holder crashed) is taken over.
    quick.memory.locks.set(route.id, { holder: 'replica-2', until: Date.now() - 1 });
    expect(await quick.engine.fireNow(route, 'admin-7')).toMatchObject({ outcome: 'done' });
  });

  it('arms every stored trigger route at boot, one broken route not stopping the rest', async () => {
    const manual = manualTrigger();
    const { engine, memory } = await setup({ triggers: [manual.trigger], actions: [noteAction([])], policies: [alwaysPolicy] });
    const base = {
      ...scope,
      name: 'r',
      enabled: true,
      action: { kind: 'test-note', config: { text: 'x' } },
      policyKind: 'always',
      target: { boardKey: 'audits', phaseKey: null },
      revision: 1,
      createdBy: 'u',
    };
    memory.routes.set('broken', { ...base, id: 'broken', trigger: { kind: 'test-webhook', config: {} } });
    memory.routes.set('fine', { ...base, id: 'fine', trigger: { kind: 'test-webhook', config: { path: '/ok' } } });
    await engine.armAll();
    expect([...manual.armed]).toEqual(['fine']);
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

  it('fires the matching armed routes of the event’s project once per event id, with its facts as payload', async () => {
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
    const { memory, add } = await setup({ triggers: [merged], actions: [noteAction(notes)], policies: [alwaysPolicy] });
    await add({ trigger: { kind: 'test-pr-merged', config: { branch: 'main' } } });
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

    expect(notes).toEqual(['PR merged → audits: release notes #42']);
    expect(memory.fires).toEqual([
      expect.objectContaining({ triggerKind: 'test-pr-merged', fireKey: 'event:evt-1', outcome: 'done' }),
    ]);
  });
});
