import { chmod, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describeFactorySandbox } from '@mastra/core/workspace';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LocalFactorySandbox } from '../local-factory-sandbox.ts';
import { sleepPolicyOf } from './local-sandbox-settings.ts';
import { LocalEnvironmentTemplate } from './local-template.ts';
import { SandboxSleeper } from './sandbox-sleeper.ts';
import { chooseSandboxesToSleep } from './sleep-policy.ts';
import { gitFixture } from './test-git.ts';
import type { GitFixture } from './test-git.ts';

const silent = { info() {}, warn() {} };
const HOUR = 60 * 60_000;

describe('which sandboxes sleep', () => {
  const now = 10 * HOUR;
  const at = (hoursAgo: number) => now - hoursAgo * HOUR;
  const policy = { maxActive: 2, idleMs: 2 * HOUR };
  const grace = { now, graceMs: 10 * 60_000 };

  it('sleeps every sandbox idle past the limit, never an active one', () => {
    const choice = chooseSandboxesToSleep(
      [
        { key: 'a', active: false, lastActivityAt: at(3) },
        { key: 'b', active: true, lastActivityAt: at(5) },
        { key: 'c', active: false, lastActivityAt: at(1) },
      ],
      policy,
      grace,
    );
    expect(choice.sleep).toEqual([{ key: 'a', reason: 'idle' }]);
  });

  it('over the limit, sleeps the longest idle; all active means nothing and a count of how far over', () => {
    expect(
      chooseSandboxesToSleep(
        [
          { key: 'a', active: false, lastActivityAt: at(0.5) },
          { key: 'b', active: false, lastActivityAt: at(1.5) },
          { key: 'c', active: false, lastActivityAt: at(1) },
          { key: 'd', active: true, lastActivityAt: at(1.9) },
        ],
        policy,
        grace,
      ).sleep,
    ).toEqual([
      { key: 'b', reason: 'limit' },
      { key: 'c', reason: 'limit' },
    ]);
    const busy = chooseSandboxesToSleep(
      [1, 2, 3].map(index => ({ key: `k${index}`, active: true, lastActivityAt: at(5) })),
      policy,
      grace,
    );
    expect(busy).toEqual({ sleep: [], overLimit: 1 });
  });

  it('never sleeps a sandbox with work seen within the grace period (a setup starting, another replica)', () => {
    expect(
      chooseSandboxesToSleep(
        [
          { key: 'a', active: false, lastActivityAt: now - 60_000 },
          { key: 'b', active: false, lastActivityAt: now - 2 * 60_000 },
          { key: 'c', active: false, lastActivityAt: now - 3 * 60_000 },
        ],
        policy,
        grace,
      ),
    ).toEqual({ sleep: [], overLimit: 1 });
  });

  it('reads the limits from a Factory’s settings, defaults filled in', () => {
    expect(sleepPolicyOf({})).toEqual({ maxActive: 5, idleMs: 2 * HOUR });
    expect(sleepPolicyOf({ maxActiveSandboxes: 3, idleSleepMinutes: 30 })).toEqual({ maxActive: 3, idleMs: 30 * 60_000 });
  });
});

describe('putting sandboxes to sleep, with real git', () => {
  let fx: GitFixture;
  let template: LocalEnvironmentTemplate;
  let sandbox: LocalFactorySandbox;
  let sandboxRoot: string;
  const running = new Set<string>();
  const released: string[] = [];
  let clock = Date.now();

  const sleeper = (policy = { maxActive: 5, idleMs: 2 * HOUR }) =>
    new SandboxSleeper({
      sandbox,
      registry: template.sandboxes,
      sessions: {
        isRunning: sessionId => running.has(sessionId),
        release: async sessionId => {
          released.push(sessionId);
          // A released session of its own destroys its sandbox, which removes its folder.
          if (sessionId.startsWith('own-')) await sandbox.create({ sessionId: sessionId.slice(4), getRepositoryAccess: undefined }).destroy();
        },
      },
      policyFor: async () => policy,
      now: () => clock,
      logger: silent,
    });

  /** A card or session folder with one checkout on a branch with work. */
  const folder = async (key: string, sessionId: string, branch: string) => {
    const dir = path.join(sandboxRoot, ...key.split('/'), 'repo');
    await mkdir(dir, { recursive: true });
    expect((await template.repositoryCache.checkout(fx.host, { cloneUrl: fx.origin }, { workdir: dir, branch: 'main' })).source).toBe('mirror');
    fx.git(dir, 'config', 'factory.orgId', 'org-1');
    fx.git(dir, 'config', 'factory.repositoryId', 'repo-1');
    fx.git(dir, 'checkout', '--quiet', '-b', branch);
    const head = await fx.commit(dir, `${branch.replaceAll('/', '-')}.txt`, 'work\n');
    await writeFile(path.join(dir, 'draft.txt'), 'draft\n');
    await sandbox.touchSandbox(dir, { sessionId, rowId: key, orgId: 'org-1', factoryProjectId: 'f' });
    return { dir, head, path: path.join(sandboxRoot, ...key.split('/')) };
  };
  const exists = (target: string) =>
    stat(target).then(
      () => true,
      () => false,
    );

  beforeEach(async () => {
    fx = await gitFixture('factory-sleep-');
    sandboxRoot = path.join(fx.root, 'sandboxes');
    template = new LocalEnvironmentTemplate({
      root: path.join(sandboxRoot, '.factory-template'),
      env: fx.env,
      logger: silent,
      freshnessMs: 0,
      isPublicRepository: async () => false,
    });
    template.setRepositoryAccess(async () => ({ cloneUrl: 'https://github.com/acme/repo.git', authorization: { scheme: 'bearer', token: 't' } }));
    sandbox = new LocalFactorySandbox({ root: sandboxRoot, template });
    await template.repositoryCache.refresh({ cloneUrl: fx.origin });
    running.clear();
    released.length = 0;
    clock = Date.now();
  });

  afterEach(async () => {
    await template.repositoryCache.settled();
    await chmod(path.join(sandboxRoot, '.factory-template', 'mirrors'), 0o755).catch(() => {});
    await rm(fx.root, { recursive: true, force: true });
  });

  it('a card sandbox sleeps: sessions released, work in the mirror and the hidden refs, folder gone, listed asleep', async () => {
    const card = await folder('work-items/f/card-1', 'agent-1', 'factory/item-1');
    const outcome = await sleeper().sleep('work-items/f/card-1', 'manual');
    expect(outcome).toEqual({ outcome: 'slept' });
    expect(released).toEqual(['agent-1']);
    expect(await exists(card.path)).toBe(false);
    expect(fx.git(fx.origin, 'rev-parse', 'refs/factory/wip/heads/factory/item-1')).toBe(card.head);
    expect(fx.tryGit(fx.origin, 'rev-parse', '--verify', 'refs/factory/wip/tree/factory/item-1').status).toBe(0);
    const [view] = await sleeper().list('f');
    expect(view).toMatchObject({ key: 'work-items/f/card-1', state: 'asleep', sleepReason: 'manual', repos: ['repo'] });
  });

  it('never stops a sandbox where an agent runs, by hand or by sweep', async () => {
    const card = await folder('work-items/f/card-2', 'agent-2', 'factory/item-2');
    running.add('agent-2');
    clock += 5 * HOUR;
    expect(await sleeper().sleep('work-items/f/card-2', 'manual')).toEqual({ outcome: 'active' });
    expect((await sleeper({ maxActive: 0, idleMs: HOUR }).sweep()).slept).toEqual([]);
    expect(await exists(card.path)).toBe(true);
    const [view] = await sleeper().list('f');
    expect(view?.state).toBe('active');
    expect(view?.sizeBytes).toBeGreaterThan(0);
  });

  it('a sweep sleeps the idle ones and, over the limit, the longest idle', async () => {
    const older = await folder('work-items/f/card-3', 'agent-3', 'factory/item-3');
    clock += 30 * 60_000;
    const newer = await folder('work-items/f/card-4', 'agent-4', 'factory/item-4');
    clock += 20 * 60_000;
    const report = await sleeper({ maxActive: 1, idleMs: 5 * HOUR }).sweep();
    expect(report.slept).toEqual([{ key: 'work-items/f/card-3', reason: 'limit' }]);
    expect(await exists(older.path)).toBe(false);
    expect(await exists(newer.path)).toBe(true);
    clock += 6 * HOUR;
    expect((await sleeper({ maxActive: 5, idleMs: 5 * HOUR }).sweep()).slept).toEqual([{ key: 'work-items/f/card-4', reason: 'idle' }]);
  });

  it('a sandbox whose work cannot be saved keeps its folder, and the problem is on its record', async () => {
    const card = await folder('work-items/f/card-5', 'agent-5', 'factory/item-5');
    template.setRepositoryAccess(undefined);
    const outcome = await sleeper().sleep('work-items/f/card-5', 'manual');
    expect(outcome.outcome).toBe('failed');
    expect(await exists(card.path)).toBe(true);
    const [view] = await sleeper().list('f');
    expect(view?.state).toBe('idle');
    expect(view?.problems.map(problem => problem.kind)).toEqual(['save-failed']);
    // Once it can be kept, sleeping it settles the problem.
    template.setRepositoryAccess(async () => ({ cloneUrl: 'https://github.com/acme/repo.git', authorization: { scheme: 'bearer', token: 't' } }));
    expect(await sleeper().sleep('work-items/f/card-5', 'manual')).toEqual({ outcome: 'slept' });
    expect((await sleeper().list('f'))[0]?.problems).toEqual([]);
  });

  it('a session of its own sleeps too: saved and published, then its released sandbox removes the folder', async () => {
    const own = await folder('row-7', 'own-row-7', 'user/session-7');
    expect(await sleeper().sleep('row-7', 'manual')).toEqual({ outcome: 'slept' });
    expect(await exists(own.path)).toBe(false);
    expect(fx.git(fx.origin, 'rev-parse', 'refs/factory/wip/heads/user/session-7')).toBe(own.head);
    expect((await sleeper().list('f'))[0]).toMatchObject({ key: 'row-7', state: 'asleep' });
  });

  it('a closed card’s folder leaves no record; a failed save on close keeps the folder and shows the problem', async () => {
    await folder('work-items/f/card-8', 'agent-8', 'factory/item-8');
    await sandbox.removeWorkItemFolder('work-items/f/card-8');
    expect(await template.sandboxes.get('work-items/f/card-8')).toBeUndefined();

    const kept = await folder('work-items/f/card-9', 'agent-9', 'factory/item-9');
    template.setRepositoryAccess(undefined);
    await expect(sandbox.removeWorkItemFolder('work-items/f/card-9')).rejects.toThrow();
    expect(await exists(kept.path)).toBe(true);
    expect((await template.sandboxes.get('work-items/f/card-9'))?.problems?.[0]?.kind).toBe('save-failed');
  });

  it('offers the limits as Factory settings with their defaults', () => {
    const schema = describeFactorySandbox(sandbox).settingsSchema as { properties: Record<string, { default?: unknown }> };
    expect(schema.properties.maxActiveSandboxes?.default).toBe(5);
    expect(schema.properties.idleSleepMinutes?.default).toBe(120);
    expect(schema.properties.hiddenRefRetentionDays?.default).toBe(30);
  });
});
