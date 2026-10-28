import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import * as claudeCode from '@factory/harness-claude-code';
import type { ClaudeCodeHarnessConfig, ClaudeCodeSession } from '@factory/harness-claude-code';
import { FACTORY_SESSION_TOKEN_HEADER } from '@factory/mcp';
import type { FactorySessionTokenClaims } from '@factory/mcp';

import { CLAUDE_FACTORY_MCP_SERVER, createClaudeFactoryHarness, DEFAULT_CLAUDE_FACTORY_ALLOWED_TOOLS } from './harness.ts';
import type { ClaudeFactoryHarnessOptions } from './harness.ts';

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
