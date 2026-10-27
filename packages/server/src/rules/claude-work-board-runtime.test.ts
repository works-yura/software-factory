import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { InMemoryStore } from '@mastra/core/storage';
import { describe, expect, it, vi } from 'vitest';

import { HarnessRoutingStartCoordinator, prepareFactoryRuleBinding } from '@factory/api';
import { createRoutingHarness } from '@factory/harness';
import { createInMemorySessionStore } from '@factory/harness-claude-code';
import { deferred, fakeClaude } from '@factory/harness-claude-code/__fixtures__/fake-claude';
import { attachClaudeSessionToUi } from '@factory/harness-claude-code-ui';
import { createMastraHarness } from '@factory/harness-mastra';
import { GithubRules, resolveGithubRules } from '@factory/integration-github';
import type { GithubIntegration } from '@factory/integration-github';
import { createFactorySessionTokenSigner, FACTORY_SESSION_TOKEN_HEADER, resolveSessionTokenScope } from '@factory/mcp';
import { createDefaultBoardRegistry } from '@factory/pipelines';
import { createSourceControlSessionLookup } from '@factory/session';
import { createFactoryStorageForTests, FactoryDecisionDispatcher, FactoryTransitionService } from '@factory/testing';

import { ClaudeStartCoordinator, createClaudeBoundTools, createClaudeFactoryHarness } from '../claude/index.ts';

/**
 * A Work card in a factory created on the Claude Code harness, end to end
 * through the real dispatcher, rules and start path: a person starts triage,
 * Claude (a scripted `claude`) classifies the bug through the Factory's MCP
 * tools, plans behind the `submit_plan` gate while the card waits, and once a
 * person moves the card to Building the same Claude session resumes and builds.
 */

const CLAUDE_SESSION = '5d7c0f4e-claude-session';

/** One scripted CLI turn: init, the assistant's text, optionally the plan gate, and the result. */
function turn(text: string, { submitPlan = false }: { submitPlan?: boolean } = {}): string[] {
  const line = (value: unknown) => JSON.stringify(value);
  const lines = [
    line({ type: 'system', subtype: 'init', cwd: '/work', session_id: CLAUDE_SESSION, tools: [], mcp_servers: [] }),
    line({
      type: 'assistant',
      session_id: CLAUDE_SESSION,
      message: {
        id: `msg-${text.length}`,
        role: 'assistant',
        content: [
          { type: 'text', text },
          ...(submitPlan
            ? [
                {
                  type: 'tool_use',
                  id: 'toolu-plan',
                  name: 'mcp__factory_gate__submit_plan',
                  input: { title: 'Keep the phone number', plan: '1. Persist phone on save\n2. Add a test' },
                },
              ]
            : []),
        ],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    }),
  ];
  if (!submitPlan) {
    lines.push(
      line({
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: CLAUDE_SESSION,
        result: text,
        usage: {},
      }),
    );
  }
  return lines;
}

async function setup() {
  const seeded = await createFactoryStorageForTests();
  const workItems = seeded.workItems;
  const sourceControl = seeded.sourceControl.forIntegration('github');
  const integrationStorage = seeded.integrations.forIntegration<
    Record<string, unknown>,
    Record<string, unknown>,
    { kind: 'factory-pr-provenance'; factoryProjectId: string; workItemId: string }
  >('github');
  const project = await seeded.projects.create({
    orgId: 'org-1',
    userId: 'user-1',
    input: { name: 'Claude', harness: 'claude-code' },
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
  const github = {
    rules: resolveGithubRules(),
    slug: 'factory-app',
    getRepositoryCollaboratorPermission: vi.fn().mockResolvedValue('write'),
  } as unknown as GithubIntegration;
  const boards = createDefaultBoardRegistry();
  const configVersion = 'claude-runtime-v1';
  const transitionService = new FactoryTransitionService({ storage: workItems, boards, configVersion });
  const rules = new GithubRules({
    github,
    sourceControl,
    integrationStorage,
    projects: seeded.projects,
    storage: workItems,
    boards,
    configVersion,
    intake: seeded.intake,
  });
  return { seeded, workItems, sourceControl, project, boards, transitionService, rules };
}

function issueOpened() {
  return {
    event: 'issues',
    deliveryId: 'claude-issue-opened',
    payload: {
      action: 'opened',
      installation: { id: 7 },
      repository: { id: 10, full_name: 'acme/repo' },
      sender: { login: 'maintainer' },
      issue: {
        number: 42,
        title: 'Saving a profile drops the phone number',
        html_url: 'https://github.com/acme/repo/issues/42',
        created_at: '2030-01-01T00:00:00Z',
        labels: [],
      },
    },
  };
}

/** The Factory MCP server's session token in a turn's `--mcp-config`. */
function factoryToken(args: string[]): string {
  const index = args.indexOf('--mcp-config');
  for (const value of args.slice(index + 1)) {
    if (value.startsWith('--')) break;
    const token = (JSON.parse(value) as { mcpServers?: Record<string, { headers?: Record<string, string> }> })
      .mcpServers?.factory?.headers?.[FACTORY_SESSION_TOKEN_HEADER];
    if (token) return token;
  }
  throw new Error('The turn had no Factory MCP server.');
}

describe('Work board on the Claude Code harness', () => {
  it('runs triage, the plan gate and the build in one Claude session', async () => {
    const { seeded, workItems, sourceControl, project, boards, transitionService, rules } = await setup();
    const sessions = createSourceControlSessionLookup([sourceControl]);
    const signer = createFactorySessionTokenSigner('scenario-secret');
    const cwd = await mkdtemp(join(tmpdir(), 'claude-work-board-'));
    // The chat's history store (the Mastra memory domain in a real server).
    const chatStore = new InMemoryStore();

    // Triage's turn moves the card itself, as Claude would through the MCP endpoint:
    // it presents the token its turn was given, and gets the tools of its own binding.
    const triageMoved = deferred();
    let triageError: unknown;
    const fake = fakeClaude([
      { lines: turn('Triage: the save handler drops the phone field.'), holdAt: 1, hold: triageMoved.promise },
      { lines: turn('Here is the plan.', { submitPlan: true }), hang: true },
      { lines: turn('Built: the phone number is saved, with a test.') },
    ]);
    const callAgentTools = async (args: string[]) => {
      const resolved = await resolveSessionTokenScope(
        { sessionTokens: signer, projects: seeded.projects, tools: { sessions, workItems } as never },
        factoryToken(args),
        project.id,
      );
      if (!resolved) throw new Error('The session token was refused.');
      const tools = await createClaudeBoundTools(resolved.scope, { storage: workItems, transitionService, boards });
      const bound = (await tools.factory_bound_work_item!.execute!({}, {} as never)) as { revision: number };
      const moved = await tools.factory_transition_work_item!.execute!(
        { stage: 'planning', expectedRevision: bound.revision, rationale: 'A reproducible bug.', triageType: 'bug' },
        {} as never,
      );
      expect(moved).toMatchObject({ status: 'accepted' });
    };
    const spawn: typeof fake.spawn = (command, args, options) => {
      const child = fake.spawn(command, args, options);
      if (fake.calls.length === 1) {
        void callAgentTools(args)
          .catch(error => {
            triageError = error;
          })
          .finally(() => triageMoved.resolve());
      }
      return child;
    };

    const claude = createClaudeFactoryHarness({
      store: createInMemorySessionStore(),
      sessions,
      credentials: async () => ({}),
      cwdFor: () => cwd,
      mcp: { url: id => `http://factory.test/web/factory/projects/${id}/mcp`, tokens: signer },
      spawn,
      env: { PATH: '/usr/bin' },
      onSession: session => {
        attachClaudeSessionToUi(session, { storage: chatStore });
      },
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
    const dispatcher = new FactoryDecisionDispatcher({
      harness: createRoutingHarness({ routes: [claude.route], fallback: createMastraHarness(noMastra as never) }),
      transitionService,
      storage: workItems,
      boards,
      isAutoRunEnabled: async () => true,
      ownerId: 'worker-1',
      primeCredentials: async () => {},
      prepareBinding: input =>
        prepareFactoryRuleBinding({ sourceControlStorage: sourceControl }, coordinator, seeded.projects, boards, input),
    });
    let tick = 0;
    const drain = async () => {
      for (let round = 0; round < 3; round += 1) {
        await dispatcher.runOnce(new Date(Date.UTC(2030, 0, 1, 0, 0, tick++)));
      }
    };
    const card = async () => {
      const [found] = await workItems.list({ orgId: 'org-1', factoryProjectId: project.id });
      if (!found) throw new Error('Missing card.');
      return found;
    };
    const move = async (stage: string) => {
      const current = await card();
      return transitionService.transition({
        orgId: 'org-1',
        factoryProjectId: project.id,
        workItemId: current.id,
        board: 'work',
        stage,
        expectedRevision: current.revision,
        actor: { type: 'human', id: 'user-1' },
        ingress: { type: 'human', identity: `human-${stage}` },
        cause: `move to ${stage}`,
      });
    };

    await expect(rules.ingest(issueOpened())).resolves.toEqual({ status: 'committed' });
    await drain();
    expect(await card()).toMatchObject({ board: 'work', stages: ['intake'] });
    expect(fake.calls).toHaveLength(0);

    // 1. Triage: a fresh Claude session on the card's branch runs factory-triage and moves the card.
    await expect(move('triage')).resolves.toMatchObject({ status: 'accepted' });
    await drain();
    expect(triageError).toBeUndefined();
    const triage = fake.calls[0]!;
    expect(triage.cwd).toBe(cwd);
    expect(triage.args).not.toContain('--resume');
    expect(triage.stdin).toContain('Factory Triage');
    expect(triage.args).toContain('--strict-mcp-config');
    const item = await card();
    const sessionId = item.sessions.triage!.sessionId;
    expect(await claude.store.get(sessionId)).toMatchObject({ threadId: sessionId, resourceId: project.id });

    // 2. Plan: the triage move started the plan role in the same session, in planning mode behind the gate.
    expect(item).toMatchObject({ stages: ['planning'], triageType: 'bug' });
    await drain();
    const plan = fake.calls[1]!;
    expect(plan.args).toEqual(expect.arrayContaining(['--resume', CLAUDE_SESSION, '--permission-mode', 'default']));
    expect(plan.args[plan.args.indexOf('--disallowedTools') + 1]).toContain('Write');
    expect(plan.stdin).toMatch(/^<factory-mode name="planning">/);
    expect(plan.stdin).toContain('do not call factory_transition_work_item');
    expect(plan.stdin).toContain('Factory Plan');
    const session = await claude.harness.getSession(sessionId);
    expect(session?.pendingPlan).toMatchObject({ toolCallId: 'toolu-plan' });
    // The card waits for a person: no agent can carry it on, and nothing else ran.
    expect(await card()).toMatchObject({ stages: ['planning'], sessions: { plan: { sessionId } } });
    await drain();
    expect(fake.calls).toHaveLength(2);

    // 3. Approval: a person moves the card to Building; the build resumes the same Claude session.
    await expect(move('execute')).resolves.toMatchObject({ status: 'accepted' });
    await drain();
    expect(fake.calls).toHaveLength(3);
    const build = fake.calls[2]!;
    expect(build.args).toEqual(
      expect.arrayContaining(['--resume', CLAUDE_SESSION, '--permission-mode', 'acceptEdits']),
    );
    expect(build.stdin).toMatch(/^The plan was approved\. Implement it\./);
    expect(build.stdin).toContain('Implement the approved plan for the work item.');
    expect(session?.pendingPlan).toBeUndefined();
    const built = await card();
    expect(built).toMatchObject({ stages: ['execute'], sessions: { work: { sessionId } } });
    expect((await claude.store.list()).map(record => record.sessionId)).toEqual([sessionId]);

    // The chat shows the card's session: every turn's input and Claude's answers, in its thread.
    const memory = await chatStore.getStore('memory');
    await vi.waitFor(async () => {
      const { messages } = await memory!.listMessages({ threadId: sessionId, perPage: 100 });
      const text = JSON.stringify(messages);
      expect(text).toContain('Triage: the save handler drops the phone field.');
      expect(text).toContain('Here is the plan.');
      expect(text).toContain('Built: the phone number is saved, with a test.');
      expect(text).toContain('Implement the approved plan for the work item.');
    });
    // The chat opens the session's thread under the Factory's shared memory resource.
    expect(await memory!.getThreadById({ threadId: sessionId })).toMatchObject({ resourceId: project.id });
  }, 60_000);
});
