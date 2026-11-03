import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import * as claudeCode from '@factory/harness-claude-code';
import type { ClaudeCodeHarnessConfig, ClaudeCodeSession } from '@factory/harness-claude-code';
import { FACTORY_SESSION_TOKEN_HEADER } from '@factory/mcp';
import type { FactorySessionTokenClaims } from '@factory/mcp';

import { CLAUDE_FACTORY_MCP_SERVER, createClaudeFactoryHarness, DEFAULT_CLAUDE_FACTORY_ALLOWED_TOOLS } from './harness.ts';
import type { ClaudeFactoryHarnessOptions } from './harness.ts';
import { RequestContext } from '@mastra/core/request-context';
import { FACTORY_INTERACTIVE_KEY } from '@factory/harness-mastra';

import { markClaudePersonTurn } from './person-turn.ts';
import { createFactoryToolPermissions } from './permissions.ts';
import { CLAUDE_THREAD_SETTINGS } from './start-coordinator.ts';

// Record the config the Factory harness hands to the Claude Code harness, so its per-turn
// hooks can be driven directly; the real harness is still built (no CLI is ever spawned).
const captured = vi.hoisted(() => ({ configs: [] as unknown[] }));
vi.mock('@factory/harness-claude-code', async importOriginal => {
  const actual = await importOriginal<typeof import('@factory/harness-claude-code')>();
  return {
    ...actual,
    createClaudeCodeHarness: (config: ClaudeCodeHarnessConfig) => {
      captured.configs.push(config);
      return actual.createClaudeCodeHarness(config);
    },
  };
});

const lastConfig = () => captured.configs.at(-1) as ClaudeCodeHarnessConfig;

interface Row {
  orgId: string;
  userId: string;
  factoryProjectId: string | null;
  originSessionId?: string;
}

function setup(
  overrides: Partial<ClaudeFactoryHarnessOptions> = {},
  rows: Record<string, Row> = {
    'session-a': { orgId: 'org-a', userId: 'user-a', factoryProjectId: 'factory-a' },
    'session-b': { orgId: 'org-b', userId: 'user-b', factoryProjectId: 'factory-b' },
  },
) {
  const signed: FactorySessionTokenClaims[] = [];
  let minted = 0;
  const tokens = {
    sign: vi.fn((claims: FactorySessionTokenClaims) => {
      signed.push(claims);
      return `token-${++minted}-${claims.sessionId}`;
    }),
  };
  const lookups: string[] = [];
  const sessions = {
    getBySessionId: vi.fn(async (sessionId: string) => {
      lookups.push(sessionId);
      return (rows[sessionId] ?? null) as never;
    }),
  };
  const credentials = vi.fn(async () => ({ ANTHROPIC_API_KEY: 'sk-test' }));
  const onCredentialFailure = vi.fn(async () => {});
  const store = claudeCode.createInMemorySessionStore();
  const factory = createClaudeFactoryHarness({
    store,
    sessionConfigRoot: join(tmpdir(), 'claude-factory-harness-test-config'),
    sessions,
    credentials,
    onCredentialFailure,
    cwdFor: () => '/nowhere',
    mcp: { url: id => `https://factory.test/mcp/${id}`, tokens },
    spawn: () => {
      throw new Error('The CLI must not be spawned in this test.');
    },
    ...overrides,
  });
  return { factory, store, tokens, signed, sessions, lookups, credentials, onCredentialFailure, config: lastConfig() };
}

type McpHook = (session: ClaudeCodeSession) => Promise<{ mcpServers: Record<string, any> }>;

describe('createClaudeFactoryHarness', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
  });

  it("tells a card run its phase the way a Mastra run's factory-phase signal does, and the supervisor none", async () => {
    const phaseFor = vi.fn(async ({ threadId }: { threadId: string }) =>
      threadId === 'thread-bound' ? 'Factory work phase: Build (build)\nRevision: 4' : undefined,
    );
    const { factory, config } = setup({ phaseFor });
    const bound = await factory.harness.createSession({ sessionId: 'session-a', threadId: 'thread-bound' });
    const unbound = await factory.harness.createSession({ sessionId: 'session-b', threadId: 'thread-free' });

    expect(await config.turnContextFor!(bound)).toBe(
      '<factory-phase>\nFactory work phase: Build (build)\nRevision: 4\n</factory-phase>',
    );
    expect(phaseFor).toHaveBeenCalledWith({
      orgId: 'org-a',
      factoryProjectId: 'factory-a',
      sessionId: 'session-a',
      threadId: 'thread-bound',
      resourceId: 'factory-a',
    });
    expect(await config.turnContextFor!(unbound)).toBeUndefined();
  });

  it("opens a turn with the factory-sessions signal a Mastra run gets, before its phase", async () => {
    const sessionsFor = vi.fn(async ({ sessionId }: { sessionId: string }) =>
      sessionId === 'session-a' ? 'Side sessions you started:\n- "Flaky test" (session s-1): running' : undefined,
    );
    const { factory, config } = setup({ sessionsFor, phaseFor: async () => 'Factory work phase: Build (build)' });
    const following = await factory.harness.createSession({ sessionId: 'session-a', threadId: 'thread-a' });
    const quiet = await factory.harness.createSession({ sessionId: 'session-b', threadId: 'thread-b' });

    expect(await config.turnContextFor!(following)).toBe(
      '<factory-sessions>\nSide sessions you started:\n- "Flaky test" (session s-1): running\n</factory-sessions>\n' +
        '<factory-phase>\nFactory work phase: Build (build)\n</factory-phase>',
    );
    expect(sessionsFor).toHaveBeenCalledWith({
      orgId: 'org-a',
      factoryProjectId: 'factory-a',
      userId: 'user-a',
      sessionId: 'session-a',
      threadId: 'thread-a',
      resourceId: 'factory-a',
    });
    expect(await config.turnContextFor!(quiet)).toBe('<factory-phase>\nFactory work phase: Build (build)\n</factory-phase>');
  });

  it('tears a deleted session down in this process, as the controller does a Mastra one', async () => {
    const { factory } = setup();
    const session = await factory.harness.createSession({ sessionId: 'session-a', threadId: 'thread-a' });
    const abort = vi.spyOn(session, 'abort');
    await factory.harness.deleteSession('session-a');
    expect(abort).toHaveBeenCalledTimes(1);
    // Forgotten here: a later lookup is a fresh object, never the torn-down one.
    expect(await factory.harness.getSession('session-a')).not.toBe(session);
    await expect(factory.harness.deleteSession('no-such-session')).resolves.toBeUndefined();
  });

  it('needs a session store or a store directory', () => {
    expect(() =>
      createClaudeFactoryHarness({
        sessions: { getBySessionId: async () => null },
        credentials: async () => ({}),
        cwdFor: () => '/nowhere',
      }),
    ).toThrow('The Claude Code harness needs a session store or a store directory.');
  });

  it('records sessions in a JSON store under storeDir when no store is given', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-factory-harness-'));
    dirs.push(dir);
    const { factory } = setup({ store: undefined, storeDir: dir });
    await factory.harness.createSession({ sessionId: 'session-a', threadId: 'thread-1' });
    const reopened = claudeCode.createJsonFileSessionStore(dir);
    expect(await reopened.get('session-a')).toMatchObject({ sessionId: 'session-a', threadId: 'thread-1' });
  });

  it('refuses to start without a place for its sessions’ config dirs: never the person’s ~/.claude', () => {
    expect(() =>
      createClaudeFactoryHarness({
        store: claudeCode.createInMemorySessionStore(),
        sessions: { getBySessionId: async () => null },
        credentials: async () => ({}),
        cwdFor: () => '/nowhere',
      }),
    ).toThrow('The Claude Code harness needs a store directory or a session config root for its config dirs.');
  });

  it('prefers an explicit store over storeDir', () => {
    const store = claudeCode.createInMemorySessionStore();
    const { factory } = setup({ store, storeDir: '/should/not/be/used' });
    expect(factory.store).toBe(store);
  });

  it('owns a session only when its store has it', async () => {
    const { factory, store } = setup();
    expect(factory.route.harness).toBe(factory.harness);
    await expect(factory.route.owns('session-a')).resolves.toBe(false);
    await factory.harness.createSession({ sessionId: 'session-a', threadId: 'thread-1' });
    await expect(factory.route.owns('session-a')).resolves.toBe(true);
    await expect(factory.route.owns('session-b')).resolves.toBe(false);
    await store.put({ sessionId: 'session-b', threadId: 't', threads: {}, updatedAt: new Date().toISOString() });
    await expect(factory.route.owns('session-b')).resolves.toBe(true);
  });

  describe('per-turn MCP config', () => {
    it('mints a token for the session’s own coordinates and mounts the factory MCP server', async () => {
      const { factory, config, signed, tokens } = setup();
      const session = await factory.harness.createSession({
        sessionId: 'session-a',
        threadId: 'thread-a',
        resourceId: 'resource-a',
      });
      const result = await (config.mcpConfig as McpHook)(session);

      expect(tokens.sign).toHaveBeenCalledTimes(1);
      expect(signed[0]).toEqual({
        orgId: 'org-a',
        factoryProjectId: 'factory-a',
        sessionId: 'session-a',
        threadId: 'thread-a',
        resourceId: 'resource-a',
      });
      expect(FACTORY_SESSION_TOKEN_HEADER).toBe('x-factory-session-token');
      expect(result).toEqual({
        mcpServers: {
          [CLAUDE_FACTORY_MCP_SERVER]: {
            type: 'http',
            url: 'https://factory.test/mcp/factory-a',
            headers: { 'x-factory-session-token': 'token-1-session-a' },
          },
        },
      });
      expect(Object.keys(result.mcpServers)).toEqual(['factory']);
      expect(DEFAULT_CLAUDE_FACTORY_ALLOWED_TOOLS).toContain('mcp__factory');
    });

    it('mints a fresh token on every turn', async () => {
      const { factory, config, tokens } = setup();
      const session = await factory.harness.createSession({ sessionId: 'session-a', threadId: 'thread-a' });
      const first = await (config.mcpConfig as McpHook)(session);
      const second = await (config.mcpConfig as McpHook)(session);
      expect(tokens.sign).toHaveBeenCalledTimes(2);
      expect(first.mcpServers.factory.headers[FACTORY_SESSION_TOKEN_HEADER]).not.toBe(
        second.mcpServers.factory.headers[FACTORY_SESSION_TOKEN_HEADER],
      );
    });

    it("marks the turn a signed-in person's message started as interactive, and only that turn", async () => {
      const { factory, config, signed } = setup();
      const session = await factory.harness.createSession({ sessionId: 'session-a', threadId: 'thread-a' });
      // A wake, webhook or dispatcher turn: nobody signed in.
      await markClaudePersonTurn({ get: () => new RequestContext() }, session);
      await (config.mcpConfig as McpHook)(session);
      // A person's message over HTTP, as the auth gate marks it.
      await markClaudePersonTurn({ get: () => new RequestContext([[FACTORY_INTERACTIVE_KEY, true]]) }, session);
      await (config.mcpConfig as McpHook)(session);
      await (config.mcpConfig as McpHook)(session);
      expect(signed.map(claims => claims.interactive === true)).toEqual([false, true, false]);
    });

    it('defaults the resource to the factory when the session has none', async () => {
      const { factory, config, signed } = setup();
      const session = await factory.harness.createSession({ sessionId: 'session-a', threadId: 'thread-a' });
      await (config.mcpConfig as McpHook)(session);
      expect(signed[0]!.resourceId).toBe('factory-a');
    });

    it('never mixes one session’s coordinates into another’s token', async () => {
      const { factory, config, signed, lookups } = setup();
      const a = await factory.harness.createSession({ sessionId: 'session-a', threadId: 'thread-a' });
      const b = await factory.harness.createSession({ sessionId: 'session-b', threadId: 'thread-b' });
      const mcpB = await (config.mcpConfig as McpHook)(b);
      const mcpA = await (config.mcpConfig as McpHook)(a);

      expect(lookups).toEqual(['session-b', 'session-a']);
      expect(signed).toEqual([
        { orgId: 'org-b', factoryProjectId: 'factory-b', sessionId: 'session-b', threadId: 'thread-b', resourceId: 'factory-b' },
        { orgId: 'org-a', factoryProjectId: 'factory-a', sessionId: 'session-a', threadId: 'thread-a', resourceId: 'factory-a' },
      ]);
      expect(mcpB.mcpServers.factory.url).toBe('https://factory.test/mcp/factory-b');
      expect(mcpA.mcpServers.factory.url).toBe('https://factory.test/mcp/factory-a');
    });

    it('fails clearly, minting nothing, when the session has no Factory session row', async () => {
      const { factory, config, tokens } = setup();
      const orphan = await factory.harness.createSession({ sessionId: 'session-orphan', threadId: 't' });
      await expect((config.mcpConfig as McpHook)(orphan)).rejects.toThrow(
        'Claude Code session session-orphan has no Factory session row.',
      );
      expect(tokens.sign).not.toHaveBeenCalled();
    });

    it('treats a row without a factory as missing', async () => {
      const { factory, config, tokens } = setup({}, {
        'session-a': { orgId: 'org-a', userId: 'user-a', factoryProjectId: null },
      });
      const session = await factory.harness.createSession({ sessionId: 'session-a', threadId: 't' });
      await expect((config.mcpConfig as McpHook)(session)).rejects.toThrow(/has no Factory session row/);
      expect(tokens.sign).not.toHaveBeenCalled();
    });

    it('gives the CLI no MCP config hook when no MCP endpoint is configured', () => {
      const { config } = setup({ mcp: undefined });
      expect(config.mcpConfig).toBeUndefined();
    });
  });

  describe('per-session model', () => {
    it('reads the session Factory’s claudeCodeModel on every turn, in the session’s own org', async () => {
      const models: Record<string, string | null> = { 'factory-a': 'opus', 'factory-b': null };
      const projects = {
        get: vi.fn(async ({ id }: { orgId: string; id: string }) =>
          id in models ? ({ id, claudeCodeModel: models[id] } as never) : null,
        ),
      };
      const { factory, config } = setup({ projects });
      const a = await factory.harness.createSession({ sessionId: 'session-a', threadId: 't' });
      const b = await factory.harness.createSession({ sessionId: 'session-b', threadId: 't' });

      await expect(config.modelFor!(a)).resolves.toBe('opus');
      expect(projects.get).toHaveBeenLastCalledWith({ orgId: 'org-a', id: 'factory-a' });
      // No model chosen: the CLI's own default.
      await expect(config.modelFor!(b)).resolves.toBeUndefined();
      // Changed in settings: the next turn picks it up.
      models['factory-a'] = 'haiku';
      await expect(config.modelFor!(a)).resolves.toBe('haiku');
    });

    it('fails a turn whose session has no Factory session row', async () => {
      const { factory, config } = setup({ projects: { get: vi.fn() } });
      const orphan = await factory.harness.createSession({ sessionId: 'session-orphan', threadId: 't' });
      await expect(config.modelFor!(orphan)).rejects.toThrow(/has no Factory session row/);
    });

    it('gives the CLI no model hook without the Factories', () => {
      expect(setup().config.modelFor).toBeUndefined();
    });
  });

  describe('tool permissions', () => {
    it("reads the session Factory's permissions on every turn, in the session's own org", async () => {
      const policies: Record<string, claudeCode.ClaudeToolPermissions | undefined> = {
        'factory-a': { categories: { edit: 'ask', execute: 'deny' } },
      };
      const permissions = vi.fn(async ({ factoryProjectId }: { orgId: string; factoryProjectId: string }) => policies[factoryProjectId]);
      const { factory, config } = setup({ permissions });
      const a = await factory.harness.createSession({ sessionId: 'session-a', threadId: 't' });
      const b = await factory.harness.createSession({ sessionId: 'session-b', threadId: 't' });

      await expect(config.permissions!(a)).resolves.toEqual({ categories: { edit: 'ask', execute: 'deny' } });
      expect(permissions).toHaveBeenLastCalledWith({ orgId: 'org-a', factoryProjectId: 'factory-a' });
      // Nothing set (or nothing since a restart): every category asks.
      await expect(config.permissions!(b)).resolves.toEqual({});
      policies['factory-a'] = { yolo: true };
      await expect(config.permissions!(a)).resolves.toEqual({ yolo: true });
      expect(config.trustedMcpServers).toEqual([CLAUDE_FACTORY_MCP_SERVER]);
    });

    it('allows only the harness plumbing by default; the settings decide the rest', () => {
      expect(DEFAULT_CLAUDE_FACTORY_ALLOWED_TOOLS).toEqual(['TodoWrite', 'mcp__factory']);
    });
  });

  describe('card runs (nobody to answer a permission prompt)', () => {
    it('runs a session that ran a card role, or one another session started, unattended; a personal chat keeps asking', async () => {
      const cardRun = vi.fn(async ({ sessionId }: { sessionId: string }) => sessionId === 'session-a');
      const { factory, config } = setup(
        { permissions: async () => ({ categories: { edit: 'ask' } }), cardRun },
        {
          'session-a': { orgId: 'org-a', userId: 'user-a', factoryProjectId: 'factory-a' },
          'session-b': { orgId: 'org-a', userId: 'user-a', factoryProjectId: 'factory-a' },
          'session-side': { orgId: 'org-a', userId: 'user-a', factoryProjectId: 'factory-a', originSessionId: 'session-a' },
          'session-card': { orgId: 'org-a', userId: 'user-a', factoryProjectId: 'factory-a' },
        },
      );
      const bound = await factory.harness.createSession({ sessionId: 'session-a', threadId: 'session-a' });
      const chat = await factory.harness.createSession({ sessionId: 'session-b', threadId: 'session-b' });
      const side = await factory.harness.createSession({ sessionId: 'session-side', threadId: 'session-side' });
      const started = await factory.harness.createSession({ sessionId: 'session-card', threadId: 'session-card' });
      // The start coordinator records the card on the session's thread before its first turn.
      await started.thread.setSetting({ key: 'factoryWorkItemId', value: 'item-1' });

      await expect(config.permissions!(bound)).resolves.toEqual({
        categories: { edit: 'ask' },
        unattended: true,
        parkAsks: true,
      });
      expect(cardRun).toHaveBeenCalledWith({ orgId: 'org-a', factoryProjectId: 'factory-a', sessionId: 'session-a' });
      await expect(config.permissions!(side)).resolves.toMatchObject({ unattended: true, parkAsks: true });
      await expect(config.permissions!(started)).resolves.toMatchObject({ unattended: true, parkAsks: true });
      await expect(config.permissions!(chat)).resolves.toEqual({ categories: { edit: 'ask' } });
    });
  });

  describe('the Factory chat (supervisor) on Claude Code', () => {
    const FACTORY = '11111111-1111-4111-8111-111111111111';
    const SUPERVISOR = `factory-supervisor:${FACTORY}`;
    let workdirRoot: string | undefined;
    afterEach(async () => {
      if (workdirRoot) await rm(workdirRoot, { recursive: true, force: true });
      workdirRoot = undefined;
    });

    async function supervisorSetup(overrides: Partial<ClaudeFactoryHarnessOptions> = {}) {
      workdirRoot = await mkdtemp(join(tmpdir(), 'claude-supervisor-test-'));
      const projects = {
        get: vi.fn(async ({ orgId, id }: { orgId: string; id: string }) =>
          orgId === 'org-a' && id === FACTORY ? ({ id, orgId, claudeCodeModel: 'haiku' } as never) : null,
        ),
        getById: vi.fn(async ({ id }: { id: string }) =>
          id === FACTORY ? ({ id, orgId: 'org-a', createdBy: 'creator', harness: 'claude-code' } as never) : null,
        ),
      };
      const cwdFor = vi.fn(() => '/checkout');
      const context = setup({ projects, cwdFor, supervisorWorkdirRoot: workdirRoot, ...overrides });
      const session = await context.factory.harness.createSession({ sessionId: SUPERVISOR, threadId: SUPERVISOR, resourceId: SUPERVISOR });
      return { ...context, session, projects, cwdFor };
    }

    it('runs in a private empty folder of its own, never a checkout, with the supervisor playbook', async () => {
      const { config, session, cwdFor } = await supervisorSetup();
      const dir = await config.cwdFor(SUPERVISOR);
      expect(dir).toBe(join(workdirRoot!, encodeURIComponent(FACTORY)));
      expect(await readdir(dir)).toEqual([]);
      expect(((await stat(dir)).mode & 0o777).toString(8)).toBe('700');
      expect(cwdFor).not.toHaveBeenCalled();
      expect(await config.cwdFor('session-a')).toBe('/checkout');

      const prompt = await config.appendSystemPromptFor!(session);
      expect(prompt).toContain('# Factory supervisor');
      expect(prompt).toContain('mcp__factory__<tool>');
      const other = await setup().factory.harness.createSession({ sessionId: 'session-a', threadId: 't' });
      expect(await config.appendSystemPromptFor!(other)).toBeUndefined();

      // A card session is told where it works, after the Factory playbook.
      await other.thread.setSetting({
        key: 'factoryTargetInstruction',
        value: 'Workspace repositories: works_yura/ai, works_yura/test.',
      });
      const cardPrompt = await config.appendSystemPromptFor!(other);
      expect(cardPrompt).toContain(config.appendSystemPrompt!);
      expect(cardPrompt?.endsWith('Workspace repositories: works_yura/ai, works_yura/test.')).toBe(true);
    });

    it('mints a supervisor token acting as the person behind the turn, and runs on their credentials', async () => {
      const { config, session, signed, credentials } = await supervisorSetup();
      const mcp = config.mcpConfig as unknown as McpHook;

      await mcp(session);
      expect(signed.at(-1)).toEqual({
        orgId: 'org-a',
        factoryProjectId: FACTORY,
        sessionId: SUPERVISOR,
        threadId: SUPERVISOR,
        resourceId: SUPERVISOR,
        scope: 'supervisor',
        // Before anyone wrote, the Factory's creator.
        userId: 'creator',
      });
      await session.thread.setSetting({ key: 'factoryActorUserId', value: 'bob' });
      const config2 = await mcp(session);
      expect(signed.at(-1)).toMatchObject({ scope: 'supervisor', userId: 'bob' });
      expect(config2.mcpServers.factory.url).toBe(`https://factory.test/mcp/${FACTORY}`);
      await config.credentials(session, { exclude: [] });
      expect(credentials).toHaveBeenLastCalledWith({ orgId: 'org-a', userId: 'bob' }, { exclude: [] });
      expect(await config.modelFor!(session)).toBe('haiku');
    });

    it('asks before every repair unless the Factory auto-approves, and never runs unattended', async () => {
      const cardRun = vi.fn(async () => true);
      const { config, session } = await supervisorSetup({
        permissions: async () => ({ categories: { read: 'allow' } }),
        cardRun,
      });
      const permissions = (await config.permissions!(session))!;
      expect(permissions.unattended).toBeUndefined();
      expect(permissions.categories).toEqual({ read: 'allow' });
      expect(permissions.askEachTime).toEqual(
        expect.arrayContaining([
          'mcp__factory__factory_retry_decision',
          'mcp__factory__factory_dismiss_decision',
          'mcp__factory__factory_resolve_proposal',
          'mcp__factory__factory_transition_work_item',
          'mcp__factory__factory_reconcile_labels',
          'mcp__factory__factory_revoke_binding',
          'mcp__factory__factory_signal_session',
        ]),
      );
      expect(permissions.askEachTime).not.toContain('mcp__factory__factory_health_check');
      expect(cardRun).not.toHaveBeenCalled();
      // The rules the CLI gets: reads through the trusted server, repairs asked.
      const rules = claudeCode.claudePermissionRules(permissions, { mcpServers: ['factory'], trustedMcpServers: ['factory'] });
      expect(rules.ask).toContain('mcp__factory__factory_retry_decision');
      expect(claudeCode.claudePermissionRules({ ...permissions, yolo: true }).ask).toEqual([]);
    });

    it('fails clearly for a supervisor of a Factory that is gone', async () => {
      const { config, factory } = await supervisorSetup();
      const ghost = await factory.harness.createSession({
        sessionId: 'factory-supervisor:22222222-2222-4222-8222-222222222222',
        threadId: 't',
      });
      await expect(config.credentials(ghost, { exclude: [] })).rejects.toThrow(/was not found/);
    });
  });

  describe('createFactoryToolPermissions', () => {
    const state = (value: unknown) => ({ state: { get: () => value } });

    it("reads the Factory session's category policies and auto-approve", async () => {
      const read = createFactoryToolPermissions(async id =>
        id === 'factory-a'
          ? state({
              factoryOrgId: 'org-a',
              yolo: true,
              permissionRules: { categories: { read: 'allow', edit: 'ask', execute: 'deny', bogus: 'allow', mcp: 'maybe' }, tools: {} },
            })
          : undefined,
      );
      await expect(read({ orgId: 'org-a', factoryProjectId: 'factory-a' })).resolves.toEqual({
        categories: { read: 'allow', edit: 'ask', execute: 'deny' },
        yolo: true,
      });
      // No live Factory session (nobody opened it since the restart): nothing to apply.
      await expect(read({ orgId: 'org-a', factoryProjectId: 'factory-b' })).resolves.toBeUndefined();
    });

    it("never applies another organization's settings", async () => {
      const read = createFactoryToolPermissions(async () => state({ factoryOrgId: 'org-b', yolo: true }));
      await expect(read({ orgId: 'org-a', factoryProjectId: 'factory-a' })).resolves.toBeUndefined();
    });

    it("reads the Factory's stored settings when its session is not in memory (after a restart)", async () => {
      const get = vi.fn(async ({ orgId, id }: { orgId: string; id: string }) =>
        orgId === 'org-a' && id === 'factory-a'
          ? { toolPermissions: { categories: { execute: 'allow', other: 'deny', bogus: 'allow' }, yolo: false } }
          : null,
      );
      const read = createFactoryToolPermissions(async () => undefined, { get } as never);
      await expect(read({ orgId: 'org-a', factoryProjectId: 'factory-a' })).resolves.toEqual({
        categories: { execute: 'allow', other: 'deny' },
      });
      expect(get).toHaveBeenCalledWith({ orgId: 'org-a', id: 'factory-a' });
      // Scoped by organization, and nothing stored reads as every category asking.
      await expect(read({ orgId: 'org-b', factoryProjectId: 'factory-a' })).resolves.toBeUndefined();
      const unset = createFactoryToolPermissions(async () => undefined, { get: async () => ({ toolPermissions: null }) });
      await expect(unset({ orgId: 'org-a', factoryProjectId: 'factory-a' })).resolves.toBeUndefined();
      const yolo = createFactoryToolPermissions(async () => undefined, {
        get: async () => ({ toolPermissions: { categories: {}, yolo: true } }),
      });
      await expect(yolo({ orgId: 'org-a', factoryProjectId: 'factory-a' })).resolves.toEqual({ categories: {}, yolo: true });
    });

    it('prefers the stored copy over a stale live session, and survives a failing store', async () => {
      // Claude Code's Behavior settings write only the stored copy; a Mastra Factory session left in
      // memory (the Factory switched harness) still holds the rules from before.
      const get = vi.fn(async () => ({ toolPermissions: { categories: { read: 'deny' }, yolo: false } }));
      const stale = createFactoryToolPermissions(async () => state({ permissionRules: { categories: { read: 'allow' } } }), {
        get,
      } as never);
      await expect(stale({ orgId: 'org-a', factoryProjectId: 'factory-a' })).resolves.toEqual({ categories: { read: 'deny' } });
      // Nothing stored yet: the live session's rules apply.
      const unstored = createFactoryToolPermissions(
        async () => state({ permissionRules: { categories: { read: 'allow' } } }),
        { get: async () => ({ toolPermissions: null }) },
      );
      await expect(unstored({ orgId: 'org-a', factoryProjectId: 'factory-a' })).resolves.toEqual({ categories: { read: 'allow' } });
      const broken = createFactoryToolPermissions(async () => undefined, {
        get: async () => {
          throw new Error('db down');
        },
      });
      await expect(broken({ orgId: 'org-a', factoryProjectId: 'factory-a' })).resolves.toBeUndefined();
    });
  });

  describe('settings files of the checkout', () => {
    it("reads none from a pull or merge request checkout, and the defaults from any other", async () => {
      const { factory, config } = setup();
      const trusted = await factory.harness.createSession({ sessionId: 'session-b', threadId: 't' });
      await expect(config.settingSourcesFor!(trusted)).resolves.toBeUndefined();

      const pullRequest = await factory.harness.createSession({ sessionId: 'session-pr', threadId: 't-pr' });
      await pullRequest.thread.setSetting({ key: CLAUDE_THREAD_SETTINGS.untrustedCheckout, value: true });
      await expect(config.settingSourcesFor!(pullRequest)).resolves.toEqual([]);
    });
  });

  describe('credentials', () => {
    it('asks for the session tenant’s credentials and passes the request through', async () => {
      const { factory, config, credentials } = setup();
      const session = await factory.harness.createSession({ sessionId: 'session-b', threadId: 't' });
      const request = { preferredAccountId: 'acct-1', exclude: ['acct-0'] };
      await expect(config.credentials(session, request)).resolves.toEqual({ ANTHROPIC_API_KEY: 'sk-test' });
      expect(credentials).toHaveBeenCalledTimes(1);
      expect(credentials).toHaveBeenCalledWith({ orgId: 'org-b', userId: 'user-b' }, request);
      expect((credentials.mock.calls[0] as unknown[])[1]).toBe(request);
    });

    it('refuses credentials for a session with no Factory session row', async () => {
      const { factory, config, credentials } = setup();
      const orphan = await factory.harness.createSession({ sessionId: 'session-orphan', threadId: 't' });
      await expect(config.credentials(orphan, { exclude: [] })).rejects.toThrow(/has no Factory session row/);
      expect(credentials).not.toHaveBeenCalled();
    });

    it('reports a credential failure against the session tenant with the failure itself', async () => {
      const { factory, config, onCredentialFailure } = setup();
      const session = await factory.harness.createSession({ sessionId: 'session-a', threadId: 't' });
      const failure = {
        accountId: 'acct-1',
        error: new claudeCode.ClaudeCodeError('rate_limit', 'usage limit'),
      };
      await config.onCredentialFailure!(session, failure);
      expect(onCredentialFailure).toHaveBeenCalledWith({ orgId: 'org-a', userId: 'user-a' }, failure);
      expect((onCredentialFailure.mock.calls[0] as unknown[])[1]).toBe(failure);
    });

    it('leaves the failure hook off when none is given', () => {
      const { config } = setup({ onCredentialFailure: undefined });
      expect(config.onCredentialFailure).toBeUndefined();
    });
  });

  it('wires the Factory defaults and optional pass-throughs into the Claude Code harness', () => {
    const spawn = vi.fn();
    const onSession = vi.fn();
    const configDir = vi.fn(() => '/cfg');
    const { config } = setup({
      spawn: spawn as never,
      onSession,
      configDir,
      command: '/bin/fake-claude',
      env: { PATH: '/bin' },
      turnTimeoutMs: 1234,
    });
    expect(config).toMatchObject({
      allowedTools: DEFAULT_CLAUDE_FACTORY_ALLOWED_TOOLS,
      approvedPermissionMode: 'acceptEdits',
      command: '/bin/fake-claude',
      env: { PATH: '/bin' },
      turnTimeoutMs: 1234,
    });
    expect(config.spawn).toBe(spawn);
    expect(config.onSession).toBe(onSession);
    expect(config.configDir).toBe(configDir);
    expect(config.skillsDir).toBeTruthy();
  });

  describe('session config dirs', () => {
    let root: string | undefined;
    afterEach(async () => {
      if (root) await rm(root, { recursive: true, force: true });
      root = undefined;
    });

    it('gives each session its own seeded config dir, stable across turns, and removes it with the session', async () => {
      root = await mkdtemp(join(tmpdir(), 'claude-config-'));
      const { config, factory } = setup({ sessionConfigRoot: root });
      const first = config.configDir!({ id: 'session-a', cwd: undefined } as unknown as ClaudeCodeSession)!;
      const other = config.configDir!({ id: 'factory-supervisor:f1', cwd: undefined } as unknown as ClaudeCodeSession)!;

      expect(first.startsWith(root)).toBe(true);
      expect(other).not.toBe(first);
      expect(other).not.toContain(':');
      expect(JSON.parse(await readFile(join(first, '.claude.json'), 'utf8'))).toEqual({ hasCompletedOnboarding: true });
      expect((await stat(first)).mode & 0o777).toBe(0o700);
      // Later turns (the session has run by now) keep the same dir, so `--resume` finds its files.
      expect(config.configDir!({ id: 'session-a', cwd: '/work' } as unknown as ClaudeCodeSession)).toBe(first);

      await factory.removeSessionConfig('session-a');
      await expect(stat(first)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readdir(root)).toHaveLength(1);
      // Removing a session that never had a dir is fine.
      await factory.removeSessionConfig('session-never');
    });

    it('gives a session that ran on the default ~/.claude its own dir too', async () => {
      root = await mkdtemp(join(tmpdir(), 'claude-config-'));
      const { config } = setup({ sessionConfigRoot: root });
      const dir = config.configDir!({ id: 'session-old', cwd: '/work' } as unknown as ClaudeCodeSession);
      expect(dir.startsWith(root)).toBe(true);
      expect(await readdir(root)).toHaveLength(1);
    });

    it('puts the dirs next to the session store by default', async () => {
      root = await mkdtemp(join(tmpdir(), 'claude-store-'));
      const { config } = setup({ store: undefined, storeDir: join(root, 'sessions'), sessionConfigRoot: undefined });
      expect(config.configDir!({ id: 'session-a', cwd: undefined } as unknown as ClaudeCodeSession)).toContain(
        join(root, 'sessions-config'),
      );
    });
  });

  it('makes planning read-only by permission: no edits, no shell, no Factory tool that changes anything', () => {
    const { config } = setup({});
    const denied = config.planningDisallowedTools ?? [];
    expect(denied).toEqual(expect.arrayContaining(['Edit', 'Write', 'Bash']));
    for (const tool of ['factory_transition_work_item', 'factory_update_work_item', 'factory_record_review_verdict', 'factory_start_session']) {
      expect(denied).toContain(`mcp__factory__${tool}`);
    }
    for (const tool of ['factory_bound_work_item', 'factory_inspect_work_item', 'factory_list_work_items', 'search', 'fetch']) {
      expect(denied).not.toContain(`mcp__factory__${tool}`);
    }
  });
});
