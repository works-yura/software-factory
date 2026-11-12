// The harness against a real `claude` process, spawned the way the server spawns it: found by the
// resolver under a launchd-like PATH (the CLI only in `~/.local/bin`), in its own process group,
// with the turn's filtered environment. The scripted fake CLI stands in for the real one.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentEvent, AgentRunEndReason } from '@factory/harness';
import { createHarnessExecutable, isHarnessExecutableUnavailable, wellKnownExecutableDirs } from '@factory/harness/executable';

import { fixture } from './__fixtures__/fake-claude.ts';
import { installFakeClaudeCli, type FakeClaudeCliTurn } from './__fixtures__/fake-claude-cli.ts';
import { ClaudeCodeError } from './errors.ts';
import { createClaudeCodeHarness } from './harness.ts';
import type { ClaudeCodeSession } from './session.ts';
import { createInMemorySessionStore } from './store.ts';

/** What launchd gives a service: no ~/.local/bin, no nvm. */
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

function home() {
  const root = mkdtempSync(join(tmpdir(), 'claude-process-'));
  dirs.push(root);
  const env = { PATH: LAUNCHD_PATH, HOME: root, DATABASE_URL: 'postgres://server-secret', ANTHROPIC_API_KEY: 'server-key' };
  // The server's own lookup, minus this machine's node bin and Homebrew (they may hold a real CLI).
  const executable = createHarnessExecutable({
    harness: 'Claude Code',
    name: 'claude',
    setting: 'FACTORY_CLAUDE_CODE_COMMAND',
    env,
    wellKnownDirs: wellKnownExecutableDirs({ env, execPath: join(root, 'no-node', 'node') }).filter(dir => dir.startsWith(root)),
  });
  return { root, bin: join(root, '.local', 'bin'), env, executable };
}

async function sessionFor(env: Record<string, string>, executable: ReturnType<typeof createHarnessExecutable>, root: string) {
  const harness = createClaudeCodeHarness({
    store: createInMemorySessionStore(),
    command: executable,
    credentials: async () => ({ ANTHROPIC_API_KEY: 'sk-turn' }),
    cwdFor: () => root,
    env,
  });
  const session = await harness.createSession({ sessionId: 'card-1', threadId: 'thread-1', resourceId: 'fp-1' });
  const events: AgentEvent[] = [];
  session.subscribe(event => events.push(event));
  const transcript: unknown[] = [];
  session.onTranscript(entry => transcript.push(entry));
  const requestContext = harness.runContext(session, { userId: 'user-1', orgId: 'org-1', threadId: 'thread-1', resourceId: 'fp-1' });
  const send = (id: string, contents: string) =>
    session.sendSignal({ id, type: 'user', tagName: 'user', contents }, { requestContext, requireDelivery: true }).accepted;
  return { session, events, transcript, send };
}

function nextEnd(session: ClaudeCodeSession): Promise<AgentRunEndReason | undefined> {
  return new Promise(resolve => {
    const off = session.subscribe(event => {
      if (event.type !== 'agent_end') return;
      off();
      resolve(event.reason);
    });
  });
}

/** A turn cut off before its `result`. */
const midTurn = () => fixture('turn-partial.jsonl').filter(line => !line.includes('"type":"result"'));

const errorOf = (events: AgentEvent[]) => events.find(event => event.type === 'error')?.error as ClaudeCodeError | undefined;

describe.skipIf(process.platform === 'win32')('Claude Code harness with a real CLI process', () => {
  it('finds the CLI in ~/.local/bin under a launchd PATH and streams a turn with only the turn environment', async () => {
    const { root, bin, env, executable } = home();
    const cli = installFakeClaudeCli(bin, [{ lines: fixture('turn-complete.jsonl') }]);
    const { session, transcript, send } = await sessionFor(env, executable, root);

    const end = nextEnd(session);
    await send('one', 'Update the README');
    expect(await end).toBe('complete');
    expect(JSON.stringify(transcript)).toContain('I added a usage section.');

    const [run] = cli.runs();
    expect(executable.resolve()).toMatchObject({ found: true, path: cli.path, source: 'well-known' });
    expect(run!.env.PATH).toBe(LAUNCHD_PATH);
    expect(run!.env.HOME).toBe(root);
    // The server's own secrets stay out; the turn runs on the credentials the hook chose.
    expect(run!.env.DATABASE_URL).toBeUndefined();
    expect(run!.env.ANTHROPIC_API_KEY).toBe('sk-turn');
    expect(isAlive(run!.pid)).toBe(false);
  });

  it('fails a turn once, as a missing CLI the dispatcher recognises, and runs once the CLI is installed', async () => {
    const { root, bin, env, executable } = home();
    const { session, events, send } = await sessionFor(env, executable, root);
    const looked = vi.spyOn(executable, 'command');

    const end = nextEnd(session);
    await send('one', 'go');
    expect(await end).toBe('error');
    const error = errorOf(events)!;
    expect(error).toBeInstanceOf(ClaudeCodeError);
    expect(error.message).toContain('Claude Code is not installed on this server: `claude` was not found.');
    expect(isHarnessExecutableUnavailable(error)).toBe(true);
    // Not retried here: the dispatcher decides (it fails the run as harness_not_configured).
    expect(looked).toHaveBeenCalledTimes(1);

    const cli = installFakeClaudeCli(bin, [{ lines: fixture('turn-complete.jsonl') }]);
    const next = nextEnd(session);
    await send('two', 'go');
    expect(await next).toBe('complete');
    expect(cli.runs()).toHaveLength(1);
  });

  it.each<[string, Partial<FakeClaudeCliTurn>]>([
    ['crashes mid-turn', { crash: true }],
    ['exits with an error mid-turn', { exitCode: 1, stderr: 'boom' }],
  ])('leaves no process behind when the CLI %s', async (_, behaviour) => {
    const { root, bin, env, executable } = home();
    const toolPidFile = join(root, 'tool.pid');
    const cli = installFakeClaudeCli(bin, [{ lines: midTurn(), toolPidFile, ...behaviour }]);
    const { session, events, send } = await sessionFor(env, executable, root);

    const end = nextEnd(session);
    await send('one', 'go');
    expect(await end).toBe('error');
    expect(errorOf(events)?.kind).toBe(behaviour.crash ? 'process' : 'failed');
    if (behaviour.crash) expect(errorOf(events)?.message).toBe('Claude Code was killed by SIGKILL.');
    const tool = Number(readFileSync(toolPidFile, 'utf8'));
    pids.push(tool);
    expect(isAlive(cli.runs()[0]!.pid)).toBe(false);
    // A crash takes what the CLI started with it; a CLI that exited on its own keeps what it left running.
    if (behaviour.crash) await vi.waitFor(() => expect(isAlive(tool)).toBe(false), { timeout: 2_000 });
  });

  it('stops the CLI and everything it started when the run is aborted', async () => {
    const { root, bin, env, executable } = home();
    const toolPidFile = join(root, 'tool.pid');
    const cli = installFakeClaudeCli(bin, [{ lines: midTurn(), toolPidFile, hang: true }]);
    const { session, send } = await sessionFor(env, executable, root);

    const end = nextEnd(session);
    await send('one', 'go');
    await vi.waitFor(() => expect(existsSync(toolPidFile)).toBe(true));
    const tool = Number(readFileSync(toolPidFile, 'utf8'));
    pids.push(tool, cli.runs()[0]!.pid);
    session.abort();
    expect(await end).toBe('aborted');
    await vi.waitFor(
      () => {
        expect(isAlive(cli.runs()[0]!.pid)).toBe(false);
        expect(isAlive(tool)).toBe(false);
      },
      { timeout: 3_000 },
    );
  });
});
