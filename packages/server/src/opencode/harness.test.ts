import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createInMemoryOpenCodeSessionStore, createOpenCodeCatalogSource } from '@factory/harness-opencode';
import { startFakeOpenCode, type FakeOpenCode } from '@factory/harness-opencode/testkit';
import { FACTORY_SESSION_TOKEN_HEADER } from '@factory/mcp';
import type { FactorySessionTokenClaims } from '@factory/mcp';

import { CLAUDE_THREAD_SETTINGS } from '../claude/start-coordinator.ts';
import { createOpenCodeFactoryHarness, OPENCODE_FACTORY_INSTRUCTIONS, openCodePolicyFromPermissions, type OpenCodeFactoryHarnessOptions } from './harness.ts';
import { createOpenCodeUserSessions } from './user-sessions.ts';

let fake: FakeOpenCode;

beforeEach(async () => {
  fake = await startFakeOpenCode();
  fake.onPrompt = ({ sessionId }) => {
    fake.say(sessionId, 'Done.');
    fake.idle(sessionId);
  };
  fake.providers = {
    all: [{ id: 'opencode', models: { 'big-pickle': { id: 'big-pickle', name: 'Big Pickle', status: 'active', cost: { input: 0, output: 0 } } } }],
  };
});

afterEach(async () => {
  await fake.close();
});

function setup(extra: Partial<OpenCodeFactoryHarnessOptions> = {}) {
  const signed: Array<{ claims: FactorySessionTokenClaims; ttlMs?: number }> = [];
  const project = { id: 'factory-a', orgId: 'org-a', agentLanguage: 'en', harnessModelDefaults: { opencode: { instanceId: 'opencode', model: 'opencode/big-pickle' } } };
  const root = mkdtempSync(join(tmpdir(), 'opencode-factory-'));
  const work = mkdtempSync(join(root, 'work-'));
  const factory = createOpenCodeFactoryHarness({
    store: createInMemoryOpenCodeSessionStore(),
    sessionHomeRoot: join(root, 'homes'),
    spawn: fake.spawn,
    env: { PATH: '/bin', HOME: '/home/agent', ANTHROPIC_API_KEY: 'never' },
    sessions: { getBySessionId: async id => (id === 'session-a' ? ({ orgId: 'org-a', userId: 'user-a', factoryProjectId: 'factory-a' } as never) : null) },
    projects: { get: async ({ id }) => (id === 'factory-a' ? (project as never) : null) },
    cwdFor: () => work,
    mcp: {
      url: id => `https://factory.test/web/factory/projects/${id}/mcp`,
      tokens: { sign: (claims, options) => (signed.push({ claims, ...(options?.ttlMs ? { ttlMs: options.ttlMs } : {}) }), 'token-1') },
    },
    catalog: createOpenCodeCatalogSource({ installed: () => true, probe: async () => ({ providers: fake.providers }) }),
    ...extra,
  });
  return { factory, signed };
}

describe('createOpenCodeFactoryHarness', () => {
  it("runs a turn with the Factory's tools over MCP, its instructions and its model default", async () => {
    const { factory, signed } = setup();
    const session = await factory.harness.createSession({ sessionId: 'session-a', threadId: 'session-a', resourceId: 'factory-a' });
    expect(await session.sendMessage({ content: 'hello' })).toEqual({ reason: 'complete' });
    const env = fake.spawns[0]!.env;
    const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT!);
    expect(config.mcp.factory).toMatchObject({ type: 'remote', url: 'https://factory.test/web/factory/projects/factory-a/mcp', headers: { [FACTORY_SESSION_TOKEN_HEADER]: 'token-1' } });
    expect(signed[0]!.claims).toMatchObject({ orgId: 'org-a', factoryProjectId: 'factory-a', sessionId: 'session-a' });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    const prompt = fake.prompts[0]!.input;
    expect(prompt.system).toContain(OPENCODE_FACTORY_INSTRUCTIONS);
    expect(prompt.model).toEqual({ providerID: 'opencode', modelID: 'big-pickle' });
  });

  it('parks a card run where the settings ask, and offers the free models as its catalog', async () => {
    const { factory } = setup({ cardRun: () => true });
    const session = await factory.harness.createSession({ sessionId: 'session-a', threadId: 'session-a', resourceId: 'factory-a' });
    await session.sendMessage({ content: 'work' });
    const rules = JSON.parse(fake.spawns[0]!.env.OPENCODE_CONFIG_CONTENT!).permission;
    expect(rules).toMatchObject({ edit: 'ask', bash: 'ask', external_directory: 'ask' });
    expect((await factory.models.list({ viewer: { userId: 'user-a', orgId: 'org-a' } })).map(model => [model.slug, model.badge])).toEqual([['opencode/big-pickle', 'free']]);
    expect(await factory.route.owns('session-a')).toBe(true);
    expect(await factory.route.owns('session-b')).toBe(false);
  });

  it('follows the settings for edits and commands, and never allows everything', () => {
    expect(openCodePolicyFromPermissions({ categories: { edit: 'allow', execute: 'deny' } })).toEqual({ edit: 'allow', bash: 'deny', web: 'allow' });
    expect(openCodePolicyFromPermissions({ yolo: true })).toEqual({ edit: 'ask', bash: 'ask', web: 'allow' });
    expect(openCodePolicyFromPermissions({ unattended: true, parkAsks: true })).toMatchObject({ unattended: true, parkAsks: true });
  });

  it('starts personal sessions in its store, and says why it cannot without a local sandbox', async () => {
    const { factory } = setup();
    const sessions = createOpenCodeUserSessions({ harness: factory.harness, checkout: { custom: false, sandboxProvider: 'local' } });
    await sessions.start({ session: { sessionId: 'chat-1', title: 'Chat' } as never, resourceId: 'r-1' });
    expect(await sessions.get('chat-1')).toEqual({ harness: 'opencode', resourceId: 'r-1' });
    expect(await (await factory.harness.getSession('chat-1'))!.thread.getSetting({ key: CLAUDE_THREAD_SETTINGS.title })).toBe('Chat');
    const remote = createOpenCodeUserSessions({ harness: factory.harness, checkout: { custom: false, sandboxProvider: 'e2b' } });
    expect(remote.unavailableReasonFor?.('opencode')).toContain("'e2b' sandbox");
  });
});
