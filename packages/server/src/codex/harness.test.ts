import { describe, expect, it, vi } from 'vitest';

import { createHarnessModelRegistry } from '@factory/harness';
import { createInMemoryCodexSessionStore } from '@factory/harness-codex';
import { FAKE_CODEX_MODELS, fakeCodexSpawn } from '@factory/harness-codex/testkit';
import { parseCodexModelListResponse } from '@factory/harness-codex/models';
import { FACTORY_SESSION_TOKEN_HEADER } from '@factory/mcp';
import type { FactorySessionTokenClaims } from '@factory/mcp';

import { agentLanguageInstruction } from '../agent-language.ts';
import { CLAUDE_THREAD_SETTINGS } from '../claude/start-coordinator.ts';
import { CODEX_FACTORY_INSTRUCTIONS, codexPolicyFromPermissions, createCodexFactoryHarness } from './harness.ts';
import { combineTurnHarnessUserSessions, createCodexUserSessions } from './user-sessions.ts';

const tick = () => new Promise(resolve => setImmediate(resolve));

function setup(options: { cardRun?: boolean; permissions?: Parameters<typeof codexPolicyFromPermissions>[0] } = {}) {
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
  const factory = createCodexFactoryHarness({
    store: createInMemoryCodexSessionStore(),
    spawn,
    env: { PATH: '/bin' },
    sessions: { getBySessionId: async id => (id === 'session-a' ? ({ orgId: 'org-a', userId: 'user-a', factoryProjectId: 'factory-a' } as never) : null) },
    projects: { get: async ({ id }) => (id === 'factory-a' ? (project as never) : null) },
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
  return { factory, spawn, signed };
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
