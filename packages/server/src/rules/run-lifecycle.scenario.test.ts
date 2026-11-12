import { EventEmitter } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { HarnessRoutingStartCoordinator, prepareFactoryRuleBinding } from '@factory/api';
import { createRoutingHarness } from '@factory/harness';
import { createInMemorySessionStore } from '@factory/harness-claude-code';
import { fakeClaude } from '@factory/harness-claude-code/__fixtures__/fake-claude';
import { createMastraHarness } from '@factory/harness-mastra';
import { GithubRules, resolveGithubRules } from '@factory/integration-github';
import type { GithubIntegration } from '@factory/integration-github';
import { createFactorySessionTokenSigner } from '@factory/mcp';
import { autoStartingBoards, createTriageWorkRegistry } from '@factory/pipelines/testing';
import { createSourceControlSessionLookup } from '@factory/session';
import { Cards, deleteSessionRecord } from '@factory/store';
import type { FactoryDeferredDecisionRecord } from '@factory/store';
import { createFactoryStorageForTests, FactoryDecisionDispatcher, FactoryTransitionService } from '@factory/testing';
import { retryFactoryDecision } from '@factory/work-items';

import { ClaudeStartCoordinator, createClaudeFactoryHarness } from '../claude/index.ts';

/**
 * The run lifecycle end to end, through the real dispatcher, storage, start path and Claude Code
 * harness, with a scripted `claude` whose executable can be missing. It replays the incident that
 * motivated ADR-0038: the CLI was not on the server's PATH, every run failed `spawn claude ENOENT`
 * and was retried five times; a person deleted the failed session, and the binding left on it
 * failed every later run of the card. Each step here is a seam that failed then.
 */

const CLAUDE_SESSION = '0b6f3a52-lifecycle-claude-session';

/** One scripted CLI turn that ends cleanly. */
function turn(text: string): string[] {
  const line = (value: unknown) => JSON.stringify(value);
  return [
    line({ type: 'system', subtype: 'init', cwd: '/work', session_id: CLAUDE_SESSION, tools: [], mcp_servers: [] }),
    line({
      type: 'assistant',
      session_id: CLAUDE_SESSION,
      message: { id: `msg-${text.length}`, role: 'assistant', content: [{ type: 'text', text }], usage: {} },
    }),
    line({ type: 'result', subtype: 'success', is_error: false, session_id: CLAUDE_SESSION, result: text, usage: {} }),
  ];
}

/** A child Node could not start: it reports `spawn <command> ENOENT` on its `error` event, as `child_process.spawn` does. */
function missingExecutable(command: string, args: string[]) {
  const child = Object.assign(new EventEmitter(), {
    pid: undefined,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    stdin: Object.assign(new EventEmitter(), { write: () => true, end: () => {} }),
    kill: () => false,
  });
  setImmediate(() =>
    child.emit(
      'error',
      Object.assign(new Error(`spawn ${command} ENOENT`), {
        errno: -2,
        code: 'ENOENT',
        syscall: `spawn ${command}`,
        path: command,
        spawnargs: args,
      }),
    ),
  );
  return child;
}

async function setup() {
  const seeded = await createFactoryStorageForTests();
  const workItems = seeded.workItems;
  const sourceControl = seeded.sourceControl.forIntegration('github');
  const project = await seeded.projects.create({
    orgId: 'org-1',
    userId: 'user-1',
    input: { name: 'Lifecycle', harness: 'claude-code' },
  });
  const installation = await sourceControl.installations.upsert({
    orgId: 'org-1',
    connectedByUserId: 'user-1',
    externalId: '7',
  });
  const repository = await sourceControl.repositories.upsert({
    orgId: 'org-1',
    input: { installationId: installation.id, externalId: '10', slug: 'acme/repo', defaultBranch: 'main' },
  });
  const connection = await sourceControl.connections.create({
    orgId: 'org-1',
    factoryProjectId: project.id,
    installationId: installation.id,
    createdByUserId: 'user-1',
  });
  await sourceControl.projectRepositories.link({
    orgId: 'org-1',
    connectionId: connection.id,
    repositoryId: repository.id,
    createdByUserId: 'user-1',
    sandboxProvider: 'local',
    sandboxWorkdir: '/workspace',
  });
  const boards = createTriageWorkRegistry();
  const configVersion = 'lifecycle-v1';
  const transitionService = new FactoryTransitionService({ storage: workItems, boards, configVersion });
  const rules = new GithubRules({
    github: {
      rules: resolveGithubRules(),
      slug: 'factory-app',
      getRepositoryCollaboratorPermission: vi.fn().mockResolvedValue('write'),
    } as unknown as GithubIntegration,
    sourceControl,
    integrationStorage: seeded.integrations.forIntegration('github'),
    projects: seeded.projects,
    storage: workItems,
    boards,
    configVersion,
    intake: seeded.intake,
  });

  // The CLI is missing until the test installs it; every spawn is counted either way.
  const cli = { installed: false, spawns: 0 };
  const fake = fakeClaude(Array.from({ length: 8 }, (_, index) => ({ lines: turn(`Turn ${index + 1} done.`) })));
  const spawn: typeof fake.spawn = (command, args, options) => {
    cli.spawns += 1;
    if (!cli.installed) return missingExecutable(command, args) as unknown as ReturnType<typeof fake.spawn>;
    return fake.spawn(command, args, options);
  };
  const sessions = createSourceControlSessionLookup([sourceControl]);
  const cwd = await mkdtemp(join(tmpdir(), 'run-lifecycle-'));
  const claude = createClaudeFactoryHarness({
    store: createInMemorySessionStore(),
    sessionConfigRoot: join(cwd, '.claude-config'),
    sessions,
    credentials: async () => ({}),
    cwdFor: () => cwd,
    mcp: {
      url: id => `http://factory.test/web/factory/projects/${id}/mcp`,
      tokens: createFactorySessionTokenSigner('lifecycle-secret'),
    },
    spawn,
    env: { PATH: '/usr/bin' },
  });
  const noMastra = { getSession: async () => undefined, listActiveThreadRuns: () => [] };
  const coordinator = new HarnessRoutingStartCoordinator(
    [noMastra as never, workItems, transitionService, sourceControl, { projects: seeded.projects }],
    {
      projects: seeded.projects,
      coordinators: {
        'claude-code': new ClaudeStartCoordinator({
          harness: claude.harness,
          storage: workItems,
          transitionService,
          sourceControl,
          projects: seeded.projects,
        }),
      },
    },
  );
  const harness = createRoutingHarness({ routes: [claude.route], fallback: createMastraHarness(noMastra as never) });
  const dispatcherFor = (ownerId: string) =>
    new FactoryDecisionDispatcher({
      harness,
      transitionService,
      storage: workItems,
      boards: autoStartingBoards(boards),
      ownerId,
      primeCredentials: async () => {},
      prepareBinding: input =>
        prepareFactoryRuleBinding({ sourceControlStorage: sourceControl }, coordinator, seeded.projects, boards, input),
    });
  const dispatcher = dispatcherFor('worker-1');

  // The dispatcher's clock: each pass runs well after every retry the previous pass scheduled.
  let clock = Date.now();
  const drain = async (target = dispatcher, rounds = 6) => {
    for (let round = 0; round < rounds; round += 1) {
      clock += 120_000;
      await target.runOnce(new Date(clock));
    }
  };
  const card = async () => {
    const [found] = await workItems.list({ orgId: 'org-1', factoryProjectId: project.id });
    if (!found) throw new Error('Missing card.');
    return found;
  };
  const move = async (stage: string) => {
    const current = await card();
    const result = await transitionService.transition({
      orgId: 'org-1',
      factoryProjectId: project.id,
      workItemId: current.id,
      board: 'work',
      stage,
      expectedRevision: current.revision,
      actor: { type: 'human', id: 'user-1' },
      ingress: { type: 'human', identity: `human-${stage}-${current.revision}` },
      cause: `move to ${stage}`,
    });
    expect(result).toMatchObject({ status: 'accepted' });
  };
  const runDecisions = async (): Promise<FactoryDeferredDecisionRecord[]> => {
    const { id } = await card();
    return (await workItems.listDeferredDecisions('org-1', project.id, { workItemId: id })).filter(
      decision => decision.decision.type === 'invokeSkill',
    );
  };
  const bindings = async () => workItems.listRunBindings('org-1', project.id, (await card()).id);

  await expect(
    rules.ingest({
      event: 'issues',
      deliveryId: 'lifecycle-issue-opened',
      payload: {
        action: 'opened',
        installation: { id: 7 },
        repository: { id: 10, full_name: 'acme/repo' },
        sender: { login: 'maintainer' },
        issue: {
          number: 7,
          title: 'Exports drop the last row',
          html_url: 'https://github.com/acme/repo/issues/7',
          created_at: '2030-01-01T00:00:00Z',
          labels: [],
        },
      },
    }),
  ).resolves.toEqual({ status: 'committed' });
  await drain();
  expect(await card()).toMatchObject({ board: 'work', stages: ['intake'] });

  return {
    seeded,
    workItems,
    project,
    boards,
    sourceControl,
    claude,
    cli,
    fake,
    dispatcher,
    dispatcherFor,
    drain,
    card,
    move,
    runDecisions,
    bindings,
    now: () => clock,
  };
}

describe('the run lifecycle, end to end', () => {
  it('fails once when the agent CLI is missing, and runs when a person retries after installing it', async () => {
    const { workItems, project, boards, cli, fake, drain, card, move, runDecisions, bindings } = await setup();

    // Triage starts on its own; the spawn fails as Node reports a missing executable.
    await move('triage');
    await drain();
    expect(cli.spawns).toBe(1);
    const [failed, ...others] = await runDecisions();
    expect(others).toEqual([]);
    expect(failed).toMatchObject({
      status: 'failed',
      attempts: 1,
      failureCode: 'harness_not_configured',
    });
    expect(failed!.lastError).toContain('ENOENT');

    // Nothing retries it on its own: more passes spawn nothing.
    await drain();
    expect(cli.spawns).toBe(1);
    // The card kept its session: it is the one the retry runs in.
    const sessionId = (await card()).sessions.triage?.sessionId;
    expect(sessionId).toBeDefined();
    expect((await bindings()).filter(binding => binding.status === 'active')).toEqual([
      expect.objectContaining({ role: 'triage', sessionId }),
    ]);

    // Someone installs the CLI and retries the run from the card.
    cli.installed = true;
    await expect(
      retryFactoryDecision({ workItems, boards, orgId: 'org-1', factoryProjectId: project.id, decisionId: failed!.id }),
    ).resolves.toMatchObject({ ok: true });
    await drain();
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.stdin).toContain('Factory Triage');
    expect(await runDecisions()).toEqual([expect.objectContaining({ id: failed!.id, status: 'succeeded' })]);
    expect((await card()).sessions.triage?.sessionId).toBe(sessionId);
    await drain();
    expect(cli.spawns).toBe(2);
  }, 60_000);

  it('starts a fresh session for the next run when a person deleted the card’s session', async () => {
    const { workItems, sourceControl, claude, cli, fake, drain, card, move, runDecisions, bindings } = await setup();
    cli.installed = true;

    await move('triage');
    await drain();
    expect(fake.calls).toHaveLength(1);
    const first = (await card()).sessions.triage!.sessionId;

    // The session is deleted the way the session routes delete it: the harness tears it down,
    // then its record goes, taking the card's ref and its run binding with it.
    await claude.harness.deleteSession(first);
    const row = await sourceControl.sessions.getBySessionId(first);
    await deleteSessionRecord({ sourceControl, workItems }, row!);
    expect((await card()).sessions.triage).toBeUndefined();
    expect((await bindings()).filter(binding => binding.status === 'active')).toEqual([]);

    // The card comes back to triage: its run prepares a new session and runs there, once.
    await move('intake');
    await move('triage');
    await drain();
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1]!.args).not.toContain('--resume');
    const second = (await card()).sessions.triage?.sessionId;
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
    expect((await bindings()).filter(binding => binding.status === 'active')).toEqual([
      expect.objectContaining({ role: 'triage', sessionId: second }),
    ]);
    expect((await runDecisions()).map(decision => decision.status)).toEqual(['succeeded', 'succeeded']);
  }, 60_000);

  it('heals a binding left behind on a session deleted by an older path', async () => {
    const { seeded, sourceControl, cli, fake, drain, card, move, runDecisions, bindings } = await setup();
    cli.installed = true;

    await move('triage');
    await drain();
    const first = (await card()).sessions.triage!.sessionId;

    // What a deletion before ADR-0038 left: the session's record and the card's ref gone, its binding active.
    const row = await sourceControl.sessions.getBySessionId(first);
    await sourceControl.sessions.delete(row!.id);
    await new Cards(seeded.storage.ops).updateAtomic({ id: (await card()).id }, () => ({ sessions: {} }));
    expect(await bindings()).toEqual([expect.objectContaining({ sessionId: first, status: 'active' })]);

    // The card's next run revokes it and starts in a fresh session, once.
    await move('intake');
    await move('triage');
    await drain();
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1]!.args).not.toContain('--resume');
    const second = (await card()).sessions.triage?.sessionId;
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
    expect((await bindings()).filter(binding => binding.status === 'active')).toEqual([
      expect.objectContaining({ sessionId: second }),
    ]);
    expect((await runDecisions()).map(decision => decision.status)).toEqual(['succeeded', 'succeeded']);
  }, 60_000);

  it('resumes a decision leased by a dispatcher that died, exactly once', async () => {
    const { workItems, cli, fake, dispatcherFor, drain, move, runDecisions, now } = await setup();
    cli.installed = true;

    await move('triage');
    // A dispatcher claims the run and dies before acting on it: its lease is all that is left.
    const [claimed] = await workItems.claimDeferredDecisions({
      ownerId: 'worker-dead',
      now: new Date(now()),
      leaseExpiresAt: new Date(now() + 30_000),
      limit: 1,
    });
    expect(claimed).toMatchObject({ status: 'leased', attempts: 1 });

    // The restarted servers wait for the lease, then exactly one of them runs it.
    const [left, right] = [dispatcherFor('worker-a'), dispatcherFor('worker-b')];
    await Promise.all([left.runOnce(new Date(now() + 1_000)), right.runOnce(new Date(now() + 1_000))]);
    expect(fake.calls).toHaveLength(0);
    await Promise.all([left.runOnce(new Date(now() + 31_000)), right.runOnce(new Date(now() + 31_000))]);
    await drain(left);
    await drain(right);
    expect(fake.calls).toHaveLength(1);
    expect(await runDecisions()).toEqual([expect.objectContaining({ status: 'succeeded', attempts: 2 })]);
  }, 60_000);
});
