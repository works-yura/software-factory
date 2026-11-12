import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createHarnessModelRegistry } from '@factory/harness';
import { createInMemoryCodexSessionStore } from '@factory/harness-codex';
import { FAKE_CODEX_MODELS, fakeCodexSpawn, type FakeCodexAppServer } from '@factory/harness-codex/testkit';
import { parseCodexModelListResponse } from '@factory/harness-codex/models';
import { FACTORY_SESSION_TOKEN_HEADER } from '@factory/mcp';
import type { FactorySessionTokenClaims } from '@factory/mcp';

import { agentLanguageInstruction } from '../agent-language.ts';
import { CLAUDE_THREAD_SETTINGS } from '../claude/start-coordinator.ts';
import { supervisorResourceId } from '@factory/session';

import { CODEX_SUPERVISOR_INSTRUCTIONS } from '../claude/supervisor.ts';
import { CODEX_FACTORY_INSTRUCTIONS, CODEX_QUESTION_TOOL_INSTRUCTIONS, codexPolicyFromPermissions, createCodexFactoryHarness, type CodexFactoryHarnessOptions } from './harness.ts';
import { combineTurnHarnessUserSessions, createCodexUserSessions } from './user-sessions.ts';
import type { CodexCredentials } from './credentials.ts';

const tick = () => new Promise(resolve => setImmediate(resolve));

const credentials = (usable = true): CodexCredentials => ({
  credentials: async () => ({
    tokens: { accessToken: 'at-1', chatgptAccountId: 'ws-1', planType: 'plus' },
    accountId: 'acc-1',
    credential: { label: 'alice@example.com', ownerId: 'user-a' },
  }),
  refresh: async () => undefined,
  onCredentialFailure: async () => {},
  usable: async () => usable,
});

type TurnScript = (server: FakeCodexAppServer, turn: { threadId: string; turnId: string }) => void | Promise<void>;

const done: TurnScript = (server, { threadId, turnId }) => {
  server.notify('item/completed', { threadId, turnId, item: { type: 'agentMessage', id: `m-${turnId}`, text: 'Done.' } });
  server.notify('turn/completed', { threadId, turn: { id: turnId, status: 'completed' } });
};

function setup(
  options: {
    cardRun?: boolean;
    permissions?: Parameters<typeof codexPolicyFromPermissions>[0];
    credentials?: CodexCredentials;
    turns?: TurnScript[];
    extra?: Partial<CodexFactoryHarnessOptions>;
  } = {},
) {
  let turns = 0;
  const spawn = fakeCodexSpawn(server => {
    server.handle('turn/start', params => {
      const turnId = `turn-${++turns}`;
      const script = options.turns?.[Math.min(turns, options.turns.length) - 1] ?? done;
      setImmediate(() => {
        server.notify('turn/started', { threadId: params.threadId, turn: { id: turnId, status: 'inProgress' } });
        void script(server, { threadId: params.threadId, turnId });
      });
      return { turn: { id: turnId, status: 'inProgress' } };
    });
  });
  const signed: Array<{ claims: FactorySessionTokenClaims; ttlMs?: number }> = [];
  const project = {
    id: 'factory-a',
    orgId: 'org-a',
    agentLanguage: 'en',
    harnessModelDefaults: { codex: { instanceId: 'codex', model: 'gpt-test-luna', options: [{ id: 'effort', value: 'medium' }] } },
  };
  const homeRoot = mkdtempSync(join(tmpdir(), 'codex-homes-'));
  const factory = createCodexFactoryHarness({
    store: createInMemoryCodexSessionStore(),
    sessionHomeRoot: homeRoot,
    credentials: options.credentials ?? credentials(),
    spawn,
    env: { PATH: '/bin' },
    sessions: { getBySessionId: async id => (id === 'session-a' ? ({ orgId: 'org-a', userId: 'user-a', factoryProjectId: 'factory-a' } as never) : null) },
    projects: {
      get: async ({ id }) => (id === 'factory-a' ? (project as never) : null),
      getById: async ({ id }) => (id === 'factory-a' ? ({ ...project, harness: 'codex', createdBy: 'creator' } as never) : null),
    },
    supervisorWorkdirRoot: join(homeRoot, 'supervisor'),
    cwdFor: () => '/work/session-a',
    mcp: {
      url: id => `https://factory.test/web/factory/projects/${id}/mcp`,
      tokens: {
        sign: (claims, opts) => {
          signed.push({ claims, ...(opts?.ttlMs ? { ttlMs: opts.ttlMs } : {}) });
          return `token-${claims.sessionId}`;
        },
      },
    },
    permissions: async () => options.permissions,
    cardRun: () => options.cardRun ?? false,
    phaseFor: async () => 'stage: building',
    catalog: async () => ({ available: true, models: parseCodexModelListResponse(FAKE_CODEX_MODELS) }),
    ...options.extra,
  });
  return { factory, spawn, signed, homeRoot };
}

describe('createCodexFactoryHarness', () => {
  it("runs a session's turn with the Factory's MCP tools, instructions, signals and Codex default", async () => {
    const { factory, spawn, signed } = setup();
    const session = await factory.harness.createSession({ sessionId: 'session-a', threadId: 'session-a', resourceId: 'factory-a' });
    await session.thread.setSetting({ key: CLAUDE_THREAD_SETTINGS.targetInstruction, value: 'Work in acme/web.' });
    await session.thread.setSetting({ key: CLAUDE_THREAD_SETTINGS.personTurn, value: true });
    expect(await session.sendMessage({ content: 'Fix it' })).toEqual({ reason: 'complete' });

    const server = spawn.servers[0]!;
    const thread = server.requests('thread/start')[0]!.params as any;
    expect(thread.cwd).toBe('/work/session-a');
    expect(thread.developerInstructions).toBe(`${CODEX_FACTORY_INSTRUCTIONS}\n\nWork in acme/web.\n\n${agentLanguageInstruction('en')}`);
    expect(thread.config['mcp_servers.factory']).toEqual({
      url: 'https://factory.test/web/factory/projects/factory-a/mcp',
      http_headers: { [FACTORY_SESSION_TOKEN_HEADER]: 'token-session-a' },
      tool_timeout_sec: 3900,
    });
    expect(signed).toEqual([
      {
        claims: { orgId: 'org-a', factoryProjectId: 'factory-a', sessionId: 'session-a', threadId: 'session-a', resourceId: 'factory-a', interactive: true },
        ttlMs: 8 * 60 * 60 * 1000,
      },
    ]);
    expect(await session.thread.getSetting({ key: CLAUDE_THREAD_SETTINGS.personTurn })).toBe(false);
    const turn = server.requests('turn/start')[0]!.params as any;
    expect(turn).toMatchObject({ model: 'gpt-test-luna', effort: 'medium', approvalPolicy: 'untrusted', sandboxPolicy: { type: 'readOnly' } });
    expect(turn.input[0].text).toBe('<factory-phase>\nstage: building\n</factory-phase>\n\nFix it');
  });

  it("signs each run in with its owner's ChatGPT sign-in alone, in the session's own home", async () => {
    const { factory, spawn, homeRoot } = setup();
    const session = await factory.harness.createSession({ sessionId: 'session-a', threadId: 'session-a', resourceId: 'factory-a' });
    expect(await session.sendMessage({ content: 'Fix it' })).toEqual({ reason: 'complete' });
    const home = spawn.calls[0]!.env.CODEX_HOME!;
    expect(home.startsWith(homeRoot)).toBe(true);
    expect(home).not.toContain('.codex');
    expect(spawn.calls[0]!.args).toEqual(['app-server', '-c', 'cli_auth_credentials_store="file"']);
    expect(spawn.servers[0]!.requests('account/login/start')[0]!.params).toEqual({
      type: 'chatgptAuthTokens',
      accessToken: 'at-1',
      chatgptAccountId: 'ws-1',
      chatgptPlanType: 'plus',
    });
    await factory.removeSessionHome('session-a');
    const { existsSync } = await import('node:fs');
    expect(existsSync(home)).toBe(false);
  });

  it('reads no repository config from a pull request checkout, as a Claude Code session reads no settings file', async () => {
    const { factory, spawn } = setup();
    const session = await factory.harness.createSession({ sessionId: 'session-a', threadId: 'session-a', resourceId: 'factory-a' });
    await session.thread.setSetting({ key: CLAUDE_THREAD_SETTINGS.untrustedCheckout, value: true });
    await session.sendMessage({ content: 'Review it' });
    const config = (spawn.servers[0]!.requests('thread/start')[0]!.params as any).config;
    expect(config).toMatchObject({ project_doc_max_bytes: 0, projects: { '/work/session-a': { trust_level: 'untrusted' } } });

    const trusted = setup();
    const own = await trusted.factory.harness.createSession({ sessionId: 'session-a', threadId: 'session-a', resourceId: 'factory-a' });
    await own.sendMessage({ content: 'Build it' });
    expect((trusted.spawn.servers[0]!.requests('thread/start')[0]!.params as any).config).not.toHaveProperty('project_doc_max_bytes');
  });

  it("runs a Codex Factory's chat as a Codex session: no checkout, the supervisor's tools, each repair asked", async () => {
    const { factory, spawn, signed, homeRoot } = setup();
    const id = supervisorResourceId('factory-a');
    const session = await factory.resolveSession(id);
    expect(session).toBeDefined();
    expect(await factory.models.owns(id)).toBe(true);
    await session!.thread.setSetting({ key: CLAUDE_THREAD_SETTINGS.actorUserId, value: 'user-b' });
    expect(await session!.sendMessage({ content: 'What is stuck?' })).toEqual({ reason: 'complete' });

    const thread = spawn.servers[0]!.requests('thread/start')[0]!.params as any;
    expect(thread.cwd.startsWith(join(homeRoot, 'supervisor'))).toBe(true);
    expect(thread.developerInstructions).toContain(CODEX_SUPERVISOR_INSTRUCTIONS);
    expect(thread.config['mcp_servers.factory'].tools).toMatchObject({ factory_retry_decision: { approval_mode: 'prompt' } });
    expect(signed[0]!.claims).toMatchObject({ scope: 'supervisor', userId: 'user-b', resourceId: id, sessionId: id });
    // Not a card run: it asks, and the turn carries no card signals.
    const turn = spawn.servers[0]!.requests('turn/start')[0]!.params as any;
    expect(turn.input[0].text).toBe('What is stuck?');
  });

  it('is available to a person only with a ChatGPT sign-in, and says where to add one', async () => {
    const registry = createHarnessModelRegistry([setup({ credentials: credentials(false) }).factory.models]);
    expect((await registry.describe({ viewer: { userId: 'user-a', orgId: 'org-a' } }))[0]).toMatchObject({
      available: false,
      needsSetup: true,
      reason: expect.stringContaining('Settings → Connections → Codex'),
    });
    const ready = createHarnessModelRegistry([setup().factory.models]);
    expect((await ready.describe({ viewer: { userId: 'user-a', orgId: 'org-a' } }))[0]).toMatchObject({ available: true });
  });

  it('reads the Factory default and switches a session through the registry', async () => {
    const { factory } = setup();
    await factory.harness.createSession({ sessionId: 'session-a', threadId: 'session-a', resourceId: 'factory-a' });
    const registry = createHarnessModelRegistry([factory.models]);
    const viewer = { viewer: { userId: 'user-a', orgId: 'org-a' } };
    expect(await factory.models.factoryDefault!({ ...viewer, factoryProjectId: 'factory-a' })).toMatchObject({ model: 'gpt-test-luna' });
    expect(await registry.switchSessionModel('session-a', { model: 'gpt-test-sol', options: [{ id: 'serviceTier', value: 'priority' }] }, viewer)).toMatchObject({
      ok: true,
      appliesFrom: 'next-turn',
      modelSelection: { instanceId: 'codex', model: 'gpt-test-sol' },
    });
    expect(await factory.route.owns('session-a')).toBe(true);
    expect(await factory.route.owns('other')).toBe(false);
  });

  it('runs a card run unattended: what it would ask about parks for a person', async () => {
    const { factory, spawn } = setup({ cardRun: true, permissions: { categories: { edit: 'allow', execute: 'ask' } } });
    const session = await factory.harness.createSession({ sessionId: 'session-a', threadId: 'session-a', resourceId: 'factory-a' });
    await session.sendMessage({ content: 'Build' });
    await tick();
    expect(spawn.servers[0]!.requests('turn/start')[0]!.params).toMatchObject({ approvalPolicy: 'on-request', sandboxPolicy: { type: 'workspaceWrite' } });
  });

  it('tells Codex to ask every question through request_user_input, the question card', async () => {
    expect(CODEX_FACTORY_INSTRUCTIONS).toContain(CODEX_QUESTION_TOOL_INSTRUCTIONS);
    expect(CODEX_QUESTION_TOOL_INSTRUCTIONS).toContain('`request_user_input`');
    expect(CODEX_QUESTION_TOOL_INSTRUCTIONS).toContain('`AskUserQuestion`');
    const { factory, spawn } = setup();
    const session = await factory.harness.createSession({ sessionId: 'session-a', threadId: 'session-a', resourceId: 'factory-a' });
    await session.sendMessage({ content: 'Hi' });
    const thread = spawn.servers[0]!.requests('thread/start')[0]!.params as any;
    expect(thread.developerInstructions).toContain('request_user_input');
    expect(thread.config['features.default_mode_request_user_input']).toBe(true);
  });

  it("parks a card run's question on the card and resumes the same turn with the person's answers", async () => {
    let answers: unknown;
    const { factory, spawn } = setup({
      cardRun: true,
      permissions: { categories: { edit: 'allow', execute: 'allow' } },
      turns: [
        async (server, { threadId, turnId }) => {
          answers = (
            await server.request('item/tool/requestUserInput', {
              threadId,
              turnId,
              itemId: 'q-1',
              questions: [
                { id: 'scope', header: 'Scope', question: 'Ship the MVP only?', options: [{ label: 'Yes (рекомендовано)', description: '' }, { label: 'No', description: '' }] },
                { id: 'deadline', header: 'Deadline', question: 'By when?', options: [{ label: 'Friday', description: '' }, { label: 'Next month', description: '' }] },
              ],
            })
          ).result;
          done(server, { threadId, turnId });
        },
      ],
    });
    const session = await factory.harness.createSession({ sessionId: 'session-a', threadId: 'session-a', resourceId: 'factory-a' });
    const events: string[] = [];
    session.subscribe(event => events.push(event.type === 'agent_end' ? `end:${event.reason}` : event.type));
    // A card run nobody watches still parks its question for a person (on the card and in the inbox).
    expect(await session.sendMessage({ content: 'Enrich the card' })).toEqual({ reason: 'suspended' });
    expect(spawn.servers[0]!.requests('turn/start')[0]!.params).toMatchObject({ approvalPolicy: 'on-request' });
    expect(session.pendingPermission).toMatchObject({ toolCallId: 'q-1', toolName: 'AskUserQuestion' });
    expect(events).toEqual(['tool_suspended', 'end:suspended']);
    await session.answerQuestion({ answer: '1. Ship the MVP only?\n   → Yes\n2. By when?\n   → Friday', toolCallId: 'q-1' });
    for (let i = 0; i < 50 && events.length < 3; i++) await tick();
    expect(events.at(-1)).toBe('end:complete');
    expect(answers).toEqual({ answers: { scope: { answers: ['Yes'] }, deadline: { answers: ['Friday'] } } });
    expect(spawn.servers).toHaveLength(1);
  });

  it('reads the web live on a Product card and keeps the images Codex generates', async () => {
    const kept: unknown[] = [];
    const { factory, spawn } = setup({
      turns: [
        (server, { threadId, turnId }) => {
          server.notify('item/completed', { threadId, turnId, item: { type: 'imageGeneration', id: 'ig', status: 'completed', savedPath: '/homes/a/fox.png', revisedPrompt: 'A fox' } });
          done(server, { threadId, turnId });
        },
      ],
      extra: {
        liveWebFor: async session => session.sessionId === 'session-a',
        keepGeneratedImage: async (session, image) => void kept.push({ sessionId: session.sessionId, userId: session.userId, ...image }),
      },
    });
    const session = await factory.harness.createSession({ sessionId: 'session-a', threadId: 'session-a', resourceId: 'factory-a' });
    await session.sendMessage({ content: 'Price it' });
    for (let i = 0; i < 50 && kept.length === 0; i++) await tick();
    expect((spawn.servers[0]!.requests('thread/start')[0]!.params as any).config.web_search).toBe('live');
    expect(kept).toEqual([{ sessionId: 'session-a', userId: 'user-a', path: '/homes/a/fox.png', prompt: 'A fox' }]);
  });
});

describe('codexPolicyFromPermissions', () => {
  it("maps the Factory's tool permissions onto Codex's runtime modes", () => {
    expect(codexPolicyFromPermissions(undefined)).toEqual({ runtimeMode: 'approval-required' });
    expect(codexPolicyFromPermissions({ yolo: true })).toEqual({ runtimeMode: 'full-access', networkAccess: true });
    expect(codexPolicyFromPermissions({ categories: { edit: 'allow', execute: 'allow' } })).toEqual({ runtimeMode: 'auto-accept-edits' });
    expect(codexPolicyFromPermissions({ categories: { edit: 'allow', execute: 'deny' } })).toEqual({ runtimeMode: 'approval-required' });
    expect(codexPolicyFromPermissions({ categories: { edit: 'allow' }, unattended: true, parkAsks: true })).toEqual({
      runtimeMode: 'auto-accept-edits',
      unattended: true,
      parkAsks: true,
    });
  });
});

describe('Codex personal sessions', () => {
  it('starts a personal session in the Codex store and routes each harness to its own', async () => {
    const { factory } = setup();
    const codex = createCodexUserSessions({ harness: factory.harness, checkout: { custom: false, sandboxProvider: 'local' }, unavailable: () => undefined });
    const claudeStart = vi.fn(async () => {});
    const combined = combineTurnHarnessUserSessions({
      'claude-code': { get: async id => (id === 'claude-1' ? { resourceId: 'r' } : undefined), start: claudeStart },
      codex,
    })!;
    expect(combined.harnesses).toEqual(['claude-code', 'codex']);
    const row = { sessionId: 'session-a', title: 'Fix login' } as never;
    await combined.start({ session: row, resourceId: 'user-a', harness: 'codex' });
    expect(claudeStart).not.toHaveBeenCalled();
    expect(await combined.get('session-a')).toEqual({ harness: 'codex', resourceId: 'user-a' });
    expect(await combined.get('claude-1')).toEqual({ resourceId: 'r', harness: 'claude-code' });
    const session = await factory.harness.getSession('session-a');
    expect(await session!.thread.getSetting({ key: CLAUDE_THREAD_SETTINGS.title })).toBe('Fix login');
    expect(combined.unavailableReasonFor!('codex')).toBeUndefined();
    const remote = createCodexUserSessions({ harness: factory.harness, checkout: { custom: false, sandboxProvider: 'daytona' } });
    expect(remote.unavailableReasonFor!('codex')).toContain("'daytona' sandbox");
  });
});
