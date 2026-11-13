import type { ExecuteCommandOptions } from '@mastra/core/workspace';
import { afterEach, describe, expect, it } from 'vitest';

import { MaterializeError, materializeRepo, SetupCommandError } from './github/sandbox.ts';
import type { ExecutableSandbox, SandboxCommandResult } from './materialization.ts';
import {
  classifySandboxFailure,
  createSandboxSetupReporter,
  gitProgressReader,
  onSandboxSetupProgress,
  SANDBOX_SETUP_EVENT,
  withoutGitProgress,
} from './setup-progress.ts';
import type { SandboxSetupProgressEvent, SandboxSetupTransfer } from './setup-progress.ts';

const offs: Array<() => void> = [];
afterEach(() => {
  for (const off of offs.splice(0)) off();
});

function listen(sessionId = 'session-1'): SandboxSetupProgressEvent[] {
  const events: SandboxSetupProgressEvent[] = [];
  offs.push(onSandboxSetupProgress((id, event) => id === sessionId && events.push(event)));
  return events;
}

function clock(start = 1_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

describe('createSandboxSetupReporter', () => {
  it('reports a five-repository setup step by step, in the order it runs', () => {
    const events = listen();
    const time = clock();
    const repos = ['acme/api', 'acme/book_fate', 'acme/web', 'acme/docs', 'acme/infra'];
    const reporter = createSandboxSetupReporter('session-1', repos, { now: time.now, transferIntervalMs: 1000 });

    time.advance(200);
    reporter.step('clone', 'acme/api');
    time.advance(1500);
    reporter.transfer('acme/api', { percent: 40, receivedBytes: 4096 });
    time.advance(100);
    reporter.transfer('acme/api', { percent: 41, receivedBytes: 5000 }); // within the interval: dropped
    time.advance(1000);
    reporter.transfer('acme/api', { percent: 100, receivedBytes: 9000 });
    reporter.step('checkout', 'acme/api');
    reporter.step('env-files', 'acme/api');
    reporter.step('setup', 'acme/api');
    reporter.step('clone', 'ACME/Book_Fate');
    reporter.step('setup');
    time.advance(40_000);
    reporter.finish();

    expect(events.map(({ status, phase, repo, index, total, percent, receivedBytes, elapsedMs }) => ({
      status,
      phase,
      repo,
      index,
      total,
      percent,
      receivedBytes,
      elapsedMs,
    }))).toEqual([
      { status: 'running', total: 5, elapsedMs: 0 },
      { status: 'running', phase: 'clone', repo: 'acme/api', index: 1, total: 5, elapsedMs: 200 },
      { status: 'running', phase: 'clone', repo: 'acme/api', index: 1, total: 5, percent: 40, receivedBytes: 4096, elapsedMs: 1700 },
      { status: 'running', phase: 'clone', repo: 'acme/api', index: 1, total: 5, percent: 100, receivedBytes: 9000, elapsedMs: 2800 },
      { status: 'running', phase: 'checkout', repo: 'acme/api', index: 1, total: 5, elapsedMs: 2800 },
      { status: 'running', phase: 'env-files', repo: 'acme/api', index: 1, total: 5, elapsedMs: 2800 },
      { status: 'running', phase: 'setup', repo: 'acme/api', index: 1, total: 5, elapsedMs: 2800 },
      { status: 'running', phase: 'clone', repo: 'ACME/Book_Fate', index: 2, total: 5, elapsedMs: 2800 },
      { status: 'running', phase: 'setup', total: 5, elapsedMs: 2800 },
      { status: 'done', phase: 'setup', total: 5, elapsedMs: 42_800 },
    ]);
    expect(events.every(event => event.type === SANDBOX_SETUP_EVENT && !event.failures)).toBe(true);
  });

  it('names the repository and step that failed, keeps going, and ends failed', () => {
    const events = listen();
    const reporter = createSandboxSetupReporter('session-1', ['acme/api', 'acme/book_fate']);

    reporter.step('clone', 'acme/book_fate');
    reporter.step('checkout', 'acme/api');
    reporter.fail(new MaterializeError('Sandbox command timed out after 900s during repository clone.', 'clone-failed'), {
      repo: 'acme/book_fate',
    });
    reporter.step('setup', 'acme/api');
    reporter.finish();

    const failure = {
      code: 'timeout',
      message: 'Sandbox command timed out after 900s during repository clone.',
      phase: 'clone',
      repo: 'acme/book_fate',
    };
    expect(events.at(-3)).toMatchObject({ status: 'running', failures: [failure] });
    expect(events.at(-2)).toMatchObject({ status: 'running', phase: 'setup', repo: 'acme/api', failures: [failure] });
    expect(events.at(-1)).toMatchObject({ status: 'failed', failures: [failure] });
  });

  it('ends failed at the step in progress, once per error, and then stays quiet', () => {
    const events = listen();
    const reporter = createSandboxSetupReporter('session-1', ['acme/api']);
    const error = new SetupCommandError('Setup command failed (exit 1): pnpm install', 'setup-failed');

    reporter.step('setup', 'acme/api');
    reporter.fail(error, { repo: 'acme/api', phase: 'setup' });
    reporter.finish(error);
    reporter.step('clone', 'acme/api');
    reporter.finish();

    expect(events.at(-1)).toMatchObject({
      status: 'failed',
      total: 1,
      failures: [{ code: 'setup_failed', phase: 'setup', repo: 'acme/api', message: error.message }],
    });
    expect(events).toHaveLength(4);
  });

  it('only reaches listeners still subscribed', () => {
    const events: SandboxSetupProgressEvent[] = [];
    const off = onSandboxSetupProgress((_, event) => events.push(event));
    createSandboxSetupReporter('session-2', ['acme/api']).step('clone', 'acme/api');
    off();
    createSandboxSetupReporter('session-2', ['acme/api']);
    expect(events).toHaveLength(2);
  });
});

describe('classifySandboxFailure', () => {
  it('sorts failures by what the person can do about them', () => {
    expect(classifySandboxFailure(new MaterializeError('nope', 'egress-blocked')).code).toBe('network');
    expect(classifySandboxFailure(new MaterializeError('git clone failed: fatal: Repository not found.', 'clone-failed')).code).toBe(
      'no_access',
    );
    expect(classifySandboxFailure(new MaterializeError('git clone failed: fatal: early EOF', 'clone-failed')).code).toBe(
      'clone_failed',
    );
    expect(classifySandboxFailure(new SetupCommandError('Setup command timed out', 'setup-failed')).code).toBe('setup_failed');
    expect(classifySandboxFailure('boom')).toEqual({ code: 'unknown', message: 'boom' });
  });
});

describe('gitProgressReader', () => {
  it('reads the transfer from progress lines split across chunks', () => {
    const read = gitProgressReader();
    expect(read("Cloning into '/w'...\nremote: Enumerating objects: 2741, done.\nReceiving objects:  12% (329/2741)")).toBeUndefined();
    expect(read(', 1.50 MiB | 1.2')).toBeUndefined(); // the line is not finished yet
    expect(read('0 MiB/s\rReceiving objects:  45% (1234/2741), 12.25 MiB | 2.10 MiB/s\rRec')).toEqual({
      percent: 45,
      receivedBytes: 12_845_056,
    });
    expect(read('eiving objects: 100% (2741/2741), 30.00 KiB | 5.00 MiB/s, done.\nResolving deltas:  10% (1/10)\r')).toEqual({
      percent: 100,
      receivedBytes: 30_720,
    });
    expect(read('Resolving deltas: 100% (10/10), done.\n')).toBeUndefined();
  });

  it('strips progress lines from a failed clone, keeping git’s complaint', () => {
    expect(
      withoutGitProgress(
        "Cloning into '/w'...\nremote: Counting objects:  50% (1/2)\rReceiving objects:  45% (1234/2741), 12.25 MiB | 2.10 MiB/s\rerror: RPC failed; curl 18\nfatal: early EOF\n",
      ),
    ).toBe("Cloning into '/w'...\nerror: RPC failed; curl 18\nfatal: early EOF");
  });
});

class StreamingSandbox implements ExecutableSandbox {
  readonly id = 'sandbox';
  readonly executions: Array<{ command: string; args: string[] }> = [];
  constructor(private readonly clone: (options?: ExecuteCommandOptions) => SandboxCommandResult) {}
  async executeCommand(command: string, args: string[] = [], options?: ExecuteCommandOptions): Promise<SandboxCommandResult> {
    this.executions.push({ command, args });
    if (command === 'git' && args.includes('get-url')) return { exitCode: 2, stdout: '', stderr: '' };
    if (command === 'git' && args[0] === 'clone') return this.clone(options);
    return { exitCode: 0, stdout: '', stderr: '' };
  }
}

function materialize(sandbox: ExecutableSandbox, progress?: { cloning(): void; transfer(t: SandboxSetupTransfer): void }) {
  return materializeRepo({
    row: { id: 'row', sandboxWorkdir: '/w/api', materializedAt: null },
    repoInfo: { repoFullName: 'acme/api', defaultBranch: 'main' },
    sandbox,
    token: 'tok',
    storage: { markMaterialized: async () => {} },
    ...(progress ? { progress } : {}),
  });
}

describe('materializeRepo progress', () => {
  it('clones with --progress and passes the streamed transfer on', async () => {
    const steps: string[] = [];
    const transfers: SandboxSetupTransfer[] = [];
    const sandbox = new StreamingSandbox(options => {
      options?.onStderr?.('Receiving objects:  45% (1234/2741), 2.00 MiB | 1.00 MiB/s\r');
      options?.onStderr?.('Receiving objects: 100% (2741/2741), 4.00 MiB | 1.00 MiB/s, done.\n');
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    await materialize(sandbox, { cloning: () => steps.push('cloning'), transfer: transfer => transfers.push(transfer) });

    expect(steps).toEqual(['cloning']);
    expect(sandbox.executions.find(entry => entry.args[0] === 'clone')?.args.slice(0, 2)).toEqual(['clone', '--progress']);
    expect(transfers).toEqual([
      { percent: 45, receivedBytes: 2 * 1024 ** 2 },
      { percent: 100, receivedBytes: 4 * 1024 ** 2 },
    ]);
  });

  it('names a failed clone by git’s complaint, not its progress lines', async () => {
    const sandbox = new StreamingSandbox(() => ({
      exitCode: 128,
      stdout: '',
      stderr: 'Receiving objects:  45% (1234/2741), 2.00 MiB | 1.00 MiB/s\rfatal: Authentication failed\n',
    }));

    await expect(materialize(sandbox, { cloning: () => {}, transfer: () => {} })).rejects.toThrow(
      /^git clone failed: fatal: Authentication failed$/,
    );
  });
});
