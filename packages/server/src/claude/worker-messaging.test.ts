import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createInMemorySessionStore } from '@factory/harness-claude-code';
import { deferred, fakeClaude } from '@factory/harness-claude-code/__fixtures__/fake-claude';
import { messageWorkerSession } from '@factory/supervisor';

import { createClaudeFactoryHarness } from './harness.ts';
import { claudeWorkerSession } from './worker-messaging.ts';

const line = (value: unknown) => JSON.stringify(value);
const turn = (text: string) => [
  line({ type: 'system', subtype: 'init', cwd: '/work', session_id: 'cli-1', tools: [], mcp_servers: [] }),
  line({ type: 'assistant', session_id: 'cli-1', message: { id: `m-${text}`, role: 'assistant', content: [{ type: 'text', text }] } }),
  line({ type: 'result', subtype: 'success', is_error: false, session_id: 'cli-1', result: text, usage: {} }),
];

describe('The Factory chat messaging a worker on Claude Code', () => {
  it('hands the guidance over without waiting for the worker to finish, in both deliveries', async () => {
    const release = deferred();
    // The worker's run holds until released: a long piece of work.
    const fake = fakeClaude([
      { lines: turn('Working.'), holdAt: 1, hold: release.promise },
      { lines: turn('Took the follow-up.') },
    ]);
    const cwd = await mkdtemp(join(tmpdir(), 'claude-worker-messaging-'));
    const claude = createClaudeFactoryHarness({
      store: createInMemorySessionStore(),
      sessionConfigRoot: join(cwd, '.claude-config'),
      sessions: { getBySessionId: async () => ({ orgId: 'org-1', factoryProjectId: 'p-1', userId: 'u-1' }) as never },
      credentials: async () => ({}),
      cwdFor: () => cwd,
      spawn: fake.spawn,
      env: { PATH: '/usr/bin' },
    });
    const session = await claude.harness.createSession({ sessionId: 'worker-1', threadId: 'worker-1', resourceId: 'p-1' });
    const controller = { getSession: async () => claudeWorkerSession(session) };

    // `send` wakes the idle worker and returns while its run goes on.
    await expect(
      messageWorkerSession({ controller: controller as never, sessionId: 'worker-1', message: 'Fix the test first.', delivery: 'send' }),
    ).resolves.toBeUndefined();
    expect(session.run.isRunning()).toBe(true);
    await expect.poll(() => fake.calls.length, { timeout: 10_000 }).toBe(1);

    // `queue` waits for the current run, not the caller: it returns at once and the worker takes it next.
    await expect(
      messageWorkerSession({ controller: controller as never, sessionId: 'worker-1', message: 'Then open the PR.', delivery: 'queue' }),
    ).resolves.toBeUndefined();
    expect(fake.calls).toHaveLength(1);
    release.resolve();
    await expect.poll(() => fake.calls.length, { timeout: 10_000 }).toBe(2);
    expect(fake.calls[1]!.stdin).toContain('Then open the PR.');
  }, 30_000);
});
