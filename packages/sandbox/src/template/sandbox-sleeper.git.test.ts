import { spawn } from 'node:child_process';
import { chmod, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describeFactorySandbox } from '@mastra/core/workspace';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { classifyFolderProcesses, LocalFactorySandbox } from '../local-factory-sandbox.ts';
import { withWorkItemFolderLock } from '../session-sandbox.ts';
import { sleepPolicyOf } from './local-sandbox-settings.ts';
import { LocalEnvironmentTemplate } from './local-template.ts';
import { SandboxSleeper } from './sandbox-sleeper.ts';
import { chooseSandboxesToSleep } from './sleep-policy.ts';
import { gitFixture, mirrorsOf } from './test-git.ts';
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

  it('over the limit, leaves a sandbox idle less than the minimum alone, so a busy machine does not churn', () => {
    const choice = chooseSandboxesToSleep(
      [
        { key: 'a', active: false, lastActivityAt: at(0.3) },
        { key: 'b', active: false, lastActivityAt: at(0.4) },
        { key: 'c', active: false, lastActivityAt: at(0.6) },
      ],
      policy,
      { ...grace, minIdleForLimitMs: 30 * 60_000 },
    );
    expect(choice).toEqual({ sleep: [{ key: 'c', reason: 'limit' }], overLimit: 0 });
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
  const startsOnRelease = new Set<string>();
  const queuesStartOnRelease = new Map<string, Set<string>>();
  const queuedStarts: Promise<unknown>[] = [];
  const released: string[] = [];
  let clock = Date.now();

  const bound = new Set<string>();
  const sleeper = (policy = { maxActive: 5, idleMs: 2 * HOUR }) =>
    new SandboxSleeper({
      sandbox,
      registry: template.sandboxes,
      sessions: {
        isRunning: sessionId => running.has(sessionId),
        hasActiveBinding: async sessionId => bound.has(sessionId),
        release: async sessionId => {
          released.push(sessionId);
          // A message arrives while the sandbox is being released.
          if (startsOnRelease.has(sessionId)) running.add(sessionId);
          // Or its session starts and waits for the folder's lock the sleeper holds.
          if (queuesStartOnRelease.has(sessionId)) {
            const key = sessionId.startsWith('own-') ? sessionId.slice(4) : [...queuesStartOnRelease.get(sessionId)!][0]!;
            queuedStarts.push(withWorkItemFolderLock(key, async () => {}));
          }
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
    expect((await mirrorsOf(template).checkout(fx.host, { cloneUrl: fx.origin }, { workdir: dir, branch: 'main' })).source).toBe('mirror');
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
    await mirrorsOf(template).refresh({ cloneUrl: fx.origin });
    running.clear();
    startsOnRelease.clear();
    queuesStartOnRelease.clear();
    queuedStarts.length = 0;
    bound.clear();
    released.length = 0;
    // Past the grace period of the work the fixtures record, unless a test moves it.
    clock = Date.now() + 15 * 60_000;
  });

  afterEach(async () => {
    await mirrorsOf(template).settled();
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

  it('prunes published work the remote no longer needs, never work only the hidden refs hold while the card is open', async () => {
    const day = 24 * HOUR;
    // A closed card whose branch was merged: dropped at once.
    const merged = await folder('work-items/f/card-10', 'agent-10', 'factory/item-10');
    await rm(path.join(merged.dir, 'draft.txt'));
    await sandbox.removeWorkItemFolder('work-items/f/card-10');
    fx.git(fx.seed, 'fetch', '--quiet', fx.origin, 'refs/factory/wip/heads/factory/item-10');
    fx.git(fx.seed, 'checkout', '--quiet', 'main');
    fx.git(fx.seed, 'merge', '--quiet', '--ff-only', 'FETCH_HEAD');
    fx.git(fx.seed, 'push', '--quiet', 'origin', 'main');
    // An asleep card's work only the hidden refs hold: kept, however old.
    await folder('work-items/f/card-11', 'agent-11', 'factory/item-11');
    expect(await sleeper().sleep('work-items/f/card-11', 'manual')).toEqual({ outcome: 'slept' });
    // A closed card's unmerged work: kept until the retention runs out after it closed.
    await folder('work-items/f/card-12', 'agent-12', 'factory/item-12');
    await sandbox.removeWorkItemFolder('work-items/f/card-12');

    await mirrorsOf(template).refresh({ cloneUrl: fx.origin });
    expect(await template.pruneHiddenRefs({ cloneUrl: fx.origin, retentionMs: 30 * day })).toEqual(['factory/item-10']);
    expect(fx.tryGit(fx.origin, 'rev-parse', '--verify', 'refs/factory/wip/heads/factory/item-10').status).not.toBe(0);
    expect(fx.tryGit(fx.origin, 'rev-parse', '--verify', 'refs/factory/wip/heads/factory/item-11').status).toBe(0);
    expect(fx.tryGit(fx.origin, 'rev-parse', '--verify', 'refs/factory/wip/heads/factory/item-12').status).toBe(0);

    const later = Date.now() + 31 * day;
    // Reopened: the card works on its branch again, so its earlier close no longer counts.
    const reopened = await folder('work-items/f/card-13', 'agent-13', 'factory/item-12');
    await template.saveFolder(reopened.path);
    expect(await template.pruneHiddenRefs({ cloneUrl: fx.origin, retentionMs: 30 * day, now: later })).toEqual([]);
    await sandbox.removeWorkItemFolder('work-items/f/card-13');
    await mirrorsOf(template).refresh({ cloneUrl: fx.origin });
    expect(await template.pruneHiddenRefs({ cloneUrl: fx.origin, retentionMs: 30 * day, now: later + 31 * day })).toEqual(['factory/item-12']);
    expect(fx.tryGit(fx.origin, 'rev-parse', '--verify', 'refs/factory/wip/heads/factory/item-11').status).toBe(0);
  }, 30_000);

  it('a run that starts while a card sandbox goes to sleep keeps it awake: checked again before removal', async () => {
    const card = await folder('work-items/f/card-20', 'agent-20', 'factory/item-20');
    startsOnRelease.add('agent-20');
    expect(await sleeper().sleep('work-items/f/card-20', 'manual')).toEqual({ outcome: 'active' });
    expect(await exists(card.path)).toBe(true);
    expect((await template.sandboxes.get('work-items/f/card-20'))?.state).toBe('awake');
  });

  it('a session of its own is released before anything is published or removed, and a run starting then keeps it', async () => {
    const own = await folder('row-21', 'own-row-21', 'user/session-21');
    startsOnRelease.add('own-row-21');
    expect(await sleeper().sleep('row-21', 'manual')).toEqual({ outcome: 'active' });
    expect(released).toEqual(['own-row-21']);
    // Its released sandbox did not take the folder, and nothing went to the remote yet.
    expect(await exists(own.path)).toBe(true);
    expect(fx.tryGit(fx.origin, 'rev-parse', '--verify', 'refs/factory/wip/heads/user/session-21').status).not.toBe(0);
  });

  it('stops processes left in the folder (nohup, background shells) before removing it', async () => {
    const card = await folder('work-items/f/card-22', 'agent-22', 'factory/item-22');
    const stray = spawn('sleep', ['60'], { cwd: card.dir, detached: true, stdio: 'ignore' });
    stray.unref();
    const alive = () => {
      try {
        process.kill(stray.pid!, 0);
        return true;
      } catch {
        return false;
      }
    };
    expect(alive()).toBe(true);
    expect(await sleeper().sleep('work-items/f/card-22', 'manual')).toEqual({ outcome: 'slept' });
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(alive()).toBe(false);
  });

  it('deletes a folder through the trash, so a crash mid-delete never leaves a half folder in use; the trash empties on start', async () => {
    const card = await folder('work-items/f/card-23', 'agent-23', 'factory/item-23');
    await sandbox.removeWorkItemFolder('work-items/f/card-23');
    expect(await exists(card.path)).toBe(false);
    // What a crash mid-delete leaves: a renamed folder in the trash, not the half folder at its path.
    await mkdir(path.join(sandboxRoot, '.trash', 'crashed', 'repo'), { recursive: true });
    await new LocalFactorySandbox({ root: sandboxRoot, template }).emptyTrash();
    expect(await exists(path.join(sandboxRoot, '.trash'))).toBe(false);
  });

  it('one rule decides active everywhere: work in the grace period or a card mid-pipeline is never stopped, by hand or by sweep', async () => {
    const card = await folder('work-items/f/card-24', 'agent-24', 'factory/item-24');
    // Within the grace period (another replica's heartbeat, the Files panel): active.
    clock = Date.now() + 2 * 60_000;
    expect(await sleeper().sleep('work-items/f/card-24', 'manual')).toEqual({ outcome: 'active' });
    expect((await sleeper().list('f'))[0]?.state).toBe('active');
    // Past it, but its card's run binding is active (between pipeline stages): still active.
    clock = Date.now() + 5 * HOUR;
    bound.add('agent-24');
    expect(await sleeper().sleep('work-items/f/card-24', 'manual')).toEqual({ outcome: 'active' });
    expect((await sleeper({ maxActive: 0, idleMs: HOUR }).sweep()).slept).toEqual([]);
    expect(await exists(card.path)).toBe(true);
  });

  it('a session start waiting for the folder while it goes to sleep keeps it awake, so the message never fails as retired', async () => {
    const card = await folder('work-items/f/card-25', 'agent-25', 'factory/item-25');
    queuesStartOnRelease.set('agent-25', new Set(['work-items/f/card-25']));
    expect(await sleeper().sleep('work-items/f/card-25', 'manual')).toEqual({ outcome: 'active' });
    await Promise.all(queuedStarts);
    expect(await exists(card.path)).toBe(true);
  });

  it('stops a job a sandbox shell left running after it exited (nohup), and its own children', async () => {
    const card = await folder('work-items/f/card-26', 'agent-26', 'factory/item-26');
    // A shell starts a background job and exits: the job is reparented away from this process.
    const shell = spawn('sh', ['-c', 'nohup sleep 60 >/dev/null 2>&1 & echo $!'], {
      cwd: card.dir,
      env: { ...process.env, FACTORY_SANDBOX_FOLDER: 'work-items/f/card-26' },
      detached: true,
    });
    let out = '';
    shell.stdout.on('data', chunk => (out += String(chunk)));
    await new Promise(resolve => shell.on('close', resolve));
    const orphan = Number(out.trim());
    const child = spawn('sleep', ['60'], { cwd: card.dir, stdio: 'ignore' });
    const result = await sandbox.stopProcessesIn(card.dir, 500);
    expect(result.unchecked).toBe(false);
    expect(result.stopped).toEqual(expect.arrayContaining([orphan, child.pid]));
  });

  it('leaves a person\'s shell or editor in the folder running, killing only what Factory started', () => {
    const processes = new Map([
      [10, { parent: 1, tty: false }], // the server
      [11, { parent: 10, tty: false }], // a sandbox command
      [12, { parent: 11, tty: false }], // its child
      [20, { parent: 1, tty: false }], // a nohup job whose shell exited
      [30, { parent: 31, tty: true }], // a person's shell in a terminal
      [31, { parent: 1, tty: true }],
      [40, { parent: 41, tty: false }], // an editor's helper
      [41, { parent: 1, tty: false }],
      [50, { parent: 1, tty: true }], // an orphan still on a terminal
    ]);
    const mac = classifyFolderProcesses({ candidates: [11, 12, 20, 30, 40, 50], processes, serverPid: 10, marked: new Set(), envReadable: false });
    expect(mac).toEqual({ ours: [11, 12, 20], left: [30, 40, 50] });
    // Where the environment can be read, the marker decides orphans.
    const linux = classifyFolderProcesses({ candidates: [11, 20, 40], processes, serverPid: 10, marked: new Set([40]), envReadable: true });
    expect(linux).toEqual({ ours: [11, 40], left: [20] });
  });

  it('says when the processes cannot be listed instead of pretending none are left', async () => {
    const card = await folder('work-items/f/card-27', 'agent-27', 'factory/item-27');
    const path0 = process.env.PATH;
    process.env.PATH = '/nonexistent';
    try {
      expect(await sandbox.stopProcessesIn(card.dir)).toEqual({ stopped: [], left: [], unchecked: true });
    } finally {
      process.env.PATH = path0;
    }
  });

  it('a folder on another volume (EXDEV) is deleted in place with a marker, not reported as a failed save', async () => {
    const card = await folder('work-items/f/card-28', 'agent-28', 'factory/item-28');
    const crossVolume = new LocalFactorySandbox({
      root: sandboxRoot,
      template,
      renameForRemoval: async () => {
        throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' });
      },
    });
    await crossVolume.removeWorkItemFolder('work-items/f/card-28');
    expect(await exists(card.path)).toBe(false);
    expect(await template.sandboxes.get('work-items/f/card-28')).toBeUndefined();
    // A delete in place the server did not finish: the next start finishes it.
    const interrupted = path.join(sandboxRoot, 'work-items', 'f', 'card-29');
    await mkdir(path.join(interrupted, 'repo'), { recursive: true });
    await writeFile(path.join(interrupted, '.factory-deleting'), 'x');
    await crossVolume.emptyTrash();
    expect(await exists(interrupted)).toBe(false);
  });

  it('offers the limits as Factory settings with their defaults', () => {
    const schema = describeFactorySandbox(sandbox).settingsSchema as { properties: Record<string, { default?: unknown }> };
    expect(schema.properties.maxActiveSandboxes?.default).toBe(5);
    expect(schema.properties.idleSleepMinutes?.default).toBe(120);
    expect(schema.properties.hiddenRefRetentionDays?.default).toBe(30);
  });
});
