import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createHarnessModelRegistry } from '@factory/harness';
import { createInMemoryCodexSessionStore } from '@factory/harness-codex';
import { FAKE_CODEX_MODELS, fakeCodexSpawn } from '@factory/harness-codex/testkit';
import { parseCodexModelListResponse } from '@factory/harness-codex/models';
import { FACTORY_SESSION_TOKEN_HEADER } from '@factory/mcp';
import type { FactorySessionTokenClaims } from '@factory/mcp';

import { agentLanguageInstruction } from '../agent-language.ts';
import { CLAUDE_THREAD_SETTINGS } from '../claude/start-coordinator.ts';
import { supervisorResourceId } from '@factory/session';

import { CODEX_SUPERVISOR_INSTRUCTIONS } from '../claude/supervisor.ts';
import { CODEX_FACTORY_INSTRUCTIONS, codexPolicyFromPermissions, createCodexFactoryHarness } from './harness.ts';
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

function setup(options: { cardRun?: boolean; permissions?: Parameters<typeof codexPolicyFromPermissions>[0]; credentials?: CodexCredentials } = {}) {
  const spawn = fakeCodexSpawn(server => {
    server.handle('turn/start', params => {
      setImmediate(() => {
        server.notify('turn/started', { threadId: params.threadId, turn: { id: 'turn-1', status: 'inProgress' } });
        server.notify('item/completed', { threadId: params.threadId, turnId: 'turn-1', item: { type: 'agentMessage', id: 'm', text: 'Done.' } });
        server.notify('turn/completed', { threadId: params.threadId, turn: { id: 'turn-1', status: 'completed' } });
      });
      return { turn: { id: 'turn-1', status: 'inProgress' } };
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
      reason: expect.stringContaining('Settings → Models → Codex accounts'),
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
