// The harness against a real `codex app-server` process, spawned the way the server spawns it: the
// deployment's configured command (FACTORY_CODEX_COMMAND), a launchd-like environment, its own
// process group. The scripted fake CLI stands in for the real one.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createHarnessExecutable, isHarnessExecutableUnavailable } from '@factory/harness/executable';

import { installFakeCodexCli, type FakeCodexCliSpec } from './__fixtures__/fake-codex-cli.ts';
import { createCodexHarness } from './harness.ts';
import { probeCodex } from './models/probe.ts';
import { spawnCodexAppServer } from './protocol/client.ts';
import { createInMemoryCodexSessionStore } from './store.ts';
import type { AgentEvent } from '@factory/harness';

const LAUNCHD_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

const dirs: string[] = [];
const pids: number[] = [];
afterEach(() => {
  for (const pid of pids.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function host() {
  const root = mkdtempSync(join(tmpdir(), 'codex-process-'));
  dirs.push(root);
  const env = { PATH: LAUNCHD_PATH, HOME: root, DATABASE_URL: 'postgres://server-secret', OPENAI_API_KEY: 'server-key' };
  const configured = join(root, 'opt', 'codex', 'bin', 'codex');
  const executable = createHarnessExecutable({ harness: 'Codex', name: 'codex', setting: 'FACTORY_CODEX_COMMAND', configured, env });
  return { root, env, configured, executable, install: (spec: FakeCodexCliSpec = {}) => installFakeCodexCli(join(root, 'opt', 'codex', 'bin'), spec) };
}

async function sessionFor({ root, env, executable }: ReturnType<typeof host>) {
  const harness = createCodexHarness({
    store: createInMemoryCodexSessionStore(),
    command: executable,
    cwdFor: () => root,
    env,
  });
  const session = await harness.createSession({ sessionId: 's1', threadId: 's1', resourceId: 'r1' });
  const events: AgentEvent[] = [];
  session.subscribe(event => events.push(event));
  const transcript: unknown[] = [];
  session.onTranscript(entry => transcript.push(entry));
  return { session, events, transcript };
}

const toolPid = (file: string) => {
  const pid = Number(readFileSync(file, 'utf8'));
  pids.push(pid);
  return pid;
};

describe.skipIf(process.platform === 'win32')('Codex harness with a real app-server process', () => {
  it('runs a turn on the configured CLI with only the run environment, and ends the process after it', async () => {
    const setup = host();
    const cli = setup.install({ reply: 'Fixed it.' });
    const { session, transcript } = await sessionFor(setup);

    expect(await session.sendMessage({ content: 'Fix the bug' })).toEqual({ reason: 'complete' });
    expect(JSON.stringify(transcript)).toContain('Fixed it.');
    const [run] = cli.runs();
    expect(run!.args[0]).toBe('app-server');
    expect(run!.env.PATH).toBe(LAUNCHD_PATH);
    expect(run!.env.DATABASE_URL).toBeUndefined();
    expect(run!.env.OPENAI_API_KEY).toBeUndefined();
    await vi.waitFor(() => expect(isAlive(run!.pid)).toBe(false), { timeout: 3_000 });
  });

  it('fails a send once, as a missing CLI the dispatcher recognises, and runs once the CLI is installed', async () => {
    const setup = host();
    const { session, events } = await sessionFor(setup);

    await expect(session.sendMessage({ content: 'Fix the bug' })).rejects.toThrow('Codex is not installed on this server: `' + setup.configured + '` was not found.');
    const failure = events.find((event): event is Extract<AgentEvent, { type: 'error' }> => event.type === 'error')!.error;
    expect(isHarnessExecutableUnavailable(failure)).toBe(true);

    const cli = setup.install();
    expect(await session.sendMessage({ content: 'Fix the bug' })).toEqual({ reason: 'complete' });
    expect(cli.runs()).toHaveLength(1);
  });

  it('ends a CLI that never answers the handshake, instead of waiting on it forever', async () => {
    const setup = host();
    const cli = setup.install({ silent: true });
    const started = spawnCodexAppServer({ command: setup.executable, cwd: setup.root, env: setup.env, initializeTimeoutMs: 300 });
    await expect(started).rejects.toMatchObject({ _tag: 'CodexAppServerInitializeTimeoutError' });
    const [run] = cli.runs();
    pids.push(run!.pid);
    await vi.waitFor(() => expect(isAlive(run!.pid)).toBe(false), { timeout: 3_000 });
  });

  it("gives up a model probe at its deadline even when the CLI hangs before the handshake", async () => {
    const setup = host();
    const cli = setup.install({ silent: true });
    await expect(probeCodex({ command: setup.executable, cwd: setup.root, env: setup.env, timeoutMs: 300 })).rejects.toMatchObject({
      _tag: 'CodexAppServerInitializeTimeoutError',
    });
    pids.push(cli.runs()[0]!.pid);
    await vi.waitFor(() => expect(isAlive(cli.runs()[0]!.pid)).toBe(false), { timeout: 3_000 });
  });

  it('leaves no process behind when the CLI crashes mid-turn', async () => {
    const setup = host();
    const toolPidFile = join(setup.root, 'tool.pid');
    const cli = setup.install({ turn: 'crash', toolPidFile });
    const { session, events } = await sessionFor(setup);

    expect(await session.sendMessage({ content: 'Fix the bug' })).toEqual({ reason: 'error' });
    const failure = events.find((event): event is Extract<AgentEvent, { type: 'error' }> => event.type === 'error')!.error;
    expect((failure as Error).message).toMatch(/^Codex stopped: /);
    expect(isHarnessExecutableUnavailable(failure)).toBe(false);
    const tool = toolPid(toolPidFile);
    expect(isAlive(cli.runs()[0]!.pid)).toBe(false);
    await vi.waitFor(() => expect(isAlive(tool)).toBe(false), { timeout: 4_000 });
  }, 10_000);

  it('stops the app-server and the commands it runs, even one that ignores SIGTERM, when the run is aborted', async () => {
    const setup = host();
    const toolPidFile = join(setup.root, 'tool.pid');
    const cli = setup.install({ turn: 'hang', toolPidFile, toolIgnoresSigterm: true });
    const { session } = await sessionFor(setup);

    const sent = session.sendMessage({ content: 'Fix the bug' });
    await vi.waitFor(() => expect(existsSync(toolPidFile)).toBe(true), { timeout: 3_000 });
    const tool = toolPid(toolPidFile);
    pids.push(cli.runs()[0]!.pid);
    session.abort();
    expect(await sent).toEqual({ reason: 'aborted' });
    await vi.waitFor(
      () => {
        expect(isAlive(cli.runs()[0]!.pid)).toBe(false);
        expect(isAlive(tool)).toBe(false);
      },
      { timeout: 8_000, interval: 100 },
    );
  }, 15_000);
});
