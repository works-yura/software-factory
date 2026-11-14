// A turn on the real `opencode` CLI with a free model, in a throwaway folder. Opt-in: it needs the
// CLI and the network. `FACTORY_OPENCODE_SMOKE_COMMAND=/path/to/opencode pnpm vitest run real-cli`.
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentEvent } from '@factory/harness';
import type { TranscriptEntry } from '@factory/harness/transcript';
import { describe, expect, it, onTestFinished } from 'vitest';

import { createOpenCodeHarness } from './harness.ts';
import { createOpenCodeCatalogSource } from './models.ts';
import { probeOpenCode } from './probe.ts';
import { createInMemoryOpenCodeSessionStore } from './store.ts';

const command = process.env.FACTORY_OPENCODE_SMOKE_COMMAND;
const model = process.env.FACTORY_OPENCODE_SMOKE_MODEL ?? 'opencode/big-pickle';

describe.skipIf(!command)('OpenCode on the real CLI', () => {
  it('lists its free models', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opencode-probe-'));
    const catalog = createOpenCodeCatalogSource({ installed: () => true, probe: () => probeOpenCode({ command: command!, root }) });
    const state = await catalog();
    expect(state.available).toBe(true);
    expect(state.models.some(entry => entry.slug === 'opencode/big-pickle' && entry.badge === 'free')).toBe(true);
  }, 120_000);

  it('runs a turn, asks before writing a file, and writes it once allowed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opencode-smoke-'));
    const work = await mkdtemp(join(root, 'work-'));
    const harness = createOpenCodeHarness({
      store: createInMemoryOpenCodeSessionStore(),
      cwdFor: () => work,
      stateRootFor: session => join(root, 'state', session.id),
      command: command!,
      turnSelectionFor: () => ({ model }),
      turnTimeoutMs: 180_000,
    });
    const session = await harness.createSession({ sessionId: 'smoke', threadId: 'smoke' });
    const entries: TranscriptEntry[] = [];
    const events: AgentEvent[] = [];
    session.onTranscript(entry => entries.push(entry));
    session.subscribe(event => events.push(event));
    // A failed expectation must not leave a parked turn's server running after the test.
    onTestFinished(() => session.dispose());

    const first = await session.sendMessage({ content: 'Create a file hello.txt containing exactly the word hi, using your write tool. Then reply DONE.' });
    expect(first).toEqual({ reason: 'suspended' });
    const permission = session.pendingPermission;
    expect(permission?.toolName).toBe('write_file');
    await session.respondToToolApproval({ approved: true, toolCallId: permission!.toolCallId });
    const end = await new Promise<string | undefined>(resolve => {
      const stop = session.subscribe(event => {
        if (event.type === 'agent_end') {
          stop();
          resolve(event.reason);
        }
      });
    });
    expect(end).toBe('complete');
    expect((await readFile(join(work, 'hello.txt'), 'utf8')).trim()).toBe('hi');
    expect(entries.some(entry => entry.kind === 'text')).toBe(true);
    expect(events.some(event => event.type === 'usage_update')).toBe(true);
    console.info(
      '[smoke] transcript:',
      entries.filter(entry => entry.kind !== 'text_delta' && entry.kind !== 'thinking_delta').map(entry => entry.kind),
    );
  }, 300_000);

  it('ends a turn OpenCode refuses (a model it does not have) with why, instead of waiting', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opencode-smoke-'));
    const work = await mkdtemp(join(root, 'work-'));
    const harness = createOpenCodeHarness({
      store: createInMemoryOpenCodeSessionStore(),
      cwdFor: () => work,
      stateRootFor: session => join(root, 'state', session.id),
      command: command!,
      turnSelectionFor: () => ({ model: 'opencode/no-such-model-for-the-factory' }),
      turnTimeoutMs: 90_000,
    });
    const session = await harness.createSession({ sessionId: 'smoke-refused', threadId: 'smoke-refused' });
    onTestFinished(() => session.dispose());
    const errors: unknown[] = [];
    session.subscribe(event => {
      if (event.type === 'error') errors.push(event.error);
    });
    expect(await session.sendMessage({ content: 'Say hi.' })).toEqual({ reason: 'error' });
    console.info('[smoke] refused turn:', errors.map(error => [(error as { kind?: string }).kind, (error as Error).message]));
    expect((errors[0] as { kind?: string }).kind).not.toBe('timeout');
  }, 120_000);
});
