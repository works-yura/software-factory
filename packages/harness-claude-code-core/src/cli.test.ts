import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { fakeClaude } from './__fixtures__/fake-claude.ts';
import { buildClaudeArgs, buildClaudeEnv, runClaude } from './cli.ts';
import type { ClaudeChildProcess, ClaudeSpawn } from './cli.ts';

const BASE_ARGS = [
  '-p',
  '--input-format',
  'stream-json',
  '--output-format',
  'stream-json',
  '--verbose',
  '--thinking-display',
  'summarized',
];

/** A hand-driven child process: the test decides when it prints, fails and exits. */
function scriptedChild(options: { exitOn?: NodeJS.Signals[]; pipes?: boolean } = {}) {
  const child = new EventEmitter();
  const stdout = Object.assign(new EventEmitter(), { encodings: [] as string[] });
  const stderr = Object.assign(new EventEmitter(), { encodings: [] as string[] });
  const stdin = Object.assign(new EventEmitter(), {
    written: [] as string[],
    ended: false,
    failWrites: false,
    write(chunk: string) {
      if (stdin.failWrites) throw new Error('EPIPE');
      stdin.written.push(chunk);
      return true;
    },
    end() {
      stdin.ended = true;
    },
  });
  const killed: string[] = [];
  const exitOn = options.exitOn ?? ['SIGTERM', 'SIGKILL'];
  const pipes = options.pipes ?? true;
  const fake = Object.assign(child, {
    pid: 4242,
    stdout: pipes ? Object.assign(stdout, { setEncoding: (encoding: string) => stdout.encodings.push(encoding) }) : null,
    stderr: pipes ? Object.assign(stderr, { setEncoding: (encoding: string) => stderr.encodings.push(encoding) }) : null,
    stdin: pipes ? stdin : null,
    kill(signal: NodeJS.Signals) {
      killed.push(signal);
      if (exitOn.includes(signal)) setImmediate(() => child.emit('close', null, signal));
      return true;
    },
  });
  const spawn: ClaudeSpawn = () => fake as unknown as ClaudeChildProcess;
  return { spawn, child, stdout, stderr, stdin, killed };
}

describe('buildClaudeArgs', () => {
  it('builds a non-interactive stream-json turn with the configured options', () => {
    expect(
      buildClaudeArgs({
        resumeSessionId: 'abc',
        model: 'opus',
        effort: 'high',
        permissionMode: 'acceptEdits',
        settingSources: ['project', 'local'],
        settings: { plansDirectory: '.claude/plans' },
        mcpConfig: ['/etc/factory/mcp.json', { mcpServers: { factory: { type: 'http', url: 'http://localhost/mcp' } } }],
        strictMcpConfig: true,
        allowedTools: ['Read', 'mcp__factory'],
        disallowedTools: ['Bash'],
        permissionPromptTool: 'mcp__factory_gate__permission_prompt',
        appendSystemPrompt: 'You work a Factory card.',
        includePartialMessages: true,
      }),
    ).toEqual([
      ...BASE_ARGS,
      '--include-partial-messages',
      '--resume',
      'abc',
      '--model',
      'opus',
      '--effort',
      'high',
      '--permission-mode',
      'acceptEdits',
      '--setting-sources',
      'project,local',
      '--settings',
      '{"plansDirectory":".claude/plans"}',
      '--mcp-config',
      '/etc/factory/mcp.json',
      '{"mcpServers":{"factory":{"type":"http","url":"http://localhost/mcp"}}}',
      '--strict-mcp-config',
      '--allowedTools',
      'Read,mcp__factory',
      '--disallowedTools',
      'Bash',
      '--permission-prompt-tool',
      'mcp__factory_gate__permission_prompt',
      '--append-system-prompt',
      'You work a Factory card.',
    ]);
  });

  it('passes nothing beyond the stream-json basics when no option is set', () => {
    expect(buildClaudeArgs({})).toEqual(BASE_ARGS);
    expect(buildClaudeArgs({ settings: {}, mcpConfig: [], allowedTools: [], disallowedTools: [], extraArgs: [] })).toEqual(BASE_ARGS);
  });

  it('accepts a single MCP config as a path or an object', () => {
    expect(buildClaudeArgs({ mcpConfig: '/etc/mcp.json' })).toEqual([...BASE_ARGS, '--mcp-config', '/etc/mcp.json']);
    expect(buildClaudeArgs({ mcpConfig: { mcpServers: {} } })).toEqual([...BASE_ARGS, '--mcp-config', '{"mcpServers":{}}']);
  });

  it('limits turns only with a positive count', () => {
    expect(buildClaudeArgs({ maxTurns: 3 })).toEqual([...BASE_ARGS, '--max-turns', '3']);
    expect(buildClaudeArgs({ maxTurns: 0 })).toEqual(BASE_ARGS);
    expect(buildClaudeArgs({ maxTurns: -1 })).toEqual(BASE_ARGS);
  });

  it('appends extra arguments after the built ones', () => {
    expect(buildClaudeArgs({ maxTurns: 2, extraArgs: ['--debug', '--add-dir=/data'] })).toEqual([
      ...BASE_ARGS,
      '--max-turns',
      '2',
      '--debug',
      '--add-dir=/data',
    ]);
  });

  it('refuses permission-skipping flags in any spelling', () => {
    expect(() => buildClaudeArgs({ extraArgs: ['--dangerously-skip-permissions=true'] })).toThrow(
      'Claude Code harness never passes --dangerously-skip-permissions=true.',
    );
    expect(() => buildClaudeArgs({ extraArgs: ['--allow-dangerously-skip-permissions'] })).toThrow(
      'Claude Code harness never passes --allow-dangerously-skip-permissions.',
    );
  });

  it('refuses to skip permission checks', () => {
    expect(() => buildClaudeArgs({ extraArgs: ['--dangerously-skip-permissions'] })).toThrow(/never passes/);
    expect(() => buildClaudeArgs({ permissionMode: 'bypassPermissions' as never })).toThrow(/bypassPermissions/);
  });

  it("refuses the CLI's plan mode", () => {
    expect(() => buildClaudeArgs({ permissionMode: 'plan' as never })).toThrow(/planning/);
  });
});

describe('buildClaudeEnv', () => {
  it('always tells the CLI to keep the turn credentials out of the processes it starts', () => {
    expect(buildClaudeEnv({ CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '0' }, { ANTHROPIC_API_KEY: 'k' }, ['CLAUDE_CODE_SUBPROCESS_ENV_SCRUB'])).toEqual({
      ANTHROPIC_API_KEY: 'k',
      CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1',
    });
  });

  it('keeps the server’s secrets out and lets hosts add names', () => {
    expect(
      buildClaudeEnv(
        { PATH: '/bin', XDG_CACHE_HOME: '/c', AWS_SECRET_ACCESS_KEY: 'x', DATABASE_URL: 'y', EXTRA: 'z' },
        {},
        ['EXTRA'],
      ),
    ).toEqual({ PATH: '/bin', XDG_CACHE_HOME: '/c', EXTRA: 'z', CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1' });
  });

  it('lets only the turn credentials choose the account', () => {
    expect(
      buildClaudeEnv(
        { PATH: '/bin', HOME: '/home/agent', ANTHROPIC_API_KEY: 'server', CLAUDE_CONFIG_DIR: '/srv', CLAUDECODE: '1', UNSET: undefined },
        { CLAUDE_CODE_OAUTH_TOKEN: 'oauth', CLAUDE_CONFIG_DIR: '/pool/a' },
      ),
    ).toEqual({ PATH: '/bin', HOME: '/home/agent', CLAUDE_CODE_OAUTH_TOKEN: 'oauth', CLAUDE_CONFIG_DIR: '/pool/a', CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1' });
  });
});

describe('buildClaudeEnv inheritance', () => {
  it('passes every allowlisted name and locale or XDG prefix through', () => {
    const base = Object.fromEntries(
      [
        'PATH',
        'HOME',
        'USER',
        'LOGNAME',
        'SHELL',
        'TMPDIR',
        'TMP',
        'TEMP',
        'LANG',
        'LANGUAGE',
        'TERM',
        'COLORTERM',
        'TZ',
        'NODE_EXTRA_CA_CERTS',
        'SSL_CERT_FILE',
        'SSL_CERT_DIR',
        'HTTP_PROXY',
        'HTTPS_PROXY',
        'NO_PROXY',
        'http_proxy',
        'https_proxy',
        'no_proxy',
        'SYSTEMROOT',
        'COMSPEC',
        'PATHEXT',
        'APPDATA',
        'LOCALAPPDATA',
        'USERPROFILE',
        'LC_ALL',
        'XDG_CONFIG_HOME',
      ].map(name => [name, `value of ${name}`]),
    );
    expect(buildClaudeEnv(base, {})).toEqual({ ...base, CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1' });
  });

  it('never inherits credentials or nested-session markers, even when a host asks for them', () => {
    const blocked = [
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'ANTHROPIC_BASE_URL',
      'AWS_BEARER_TOKEN_BEDROCK',
      'CLAUDE_CONFIG_DIR',
      'CLAUDE_SECURESTORAGE_CONFIG_DIR',
      'CLAUDECODE',
      'CLAUDE_CODE_ENTRYPOINT',
      'CLAUDE_CODE_SSE_PORT',
    ];
    const base = Object.fromEntries(blocked.map(name => [name, 'server']));
    expect(buildClaudeEnv({ ...base, PATH: '/bin' }, {}, blocked)).toEqual({ PATH: '/bin', CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1' });
  });

  it('keeps the credentials the hook chose, an empty sign-in dir included', () => {
    expect(
      buildClaudeEnv({ PATH: '/bin', CLAUDE_SECURESTORAGE_CONFIG_DIR: '/server/own' }, { CLAUDE_SECURESTORAGE_CONFIG_DIR: '' }),
    ).toEqual({ PATH: '/bin', CLAUDE_SECURESTORAGE_CONFIG_DIR: '', CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1' });
  });

  it('leaves out names that are unset', () => {
    expect(buildClaudeEnv({ PATH: undefined, HOME: '/home/agent' }, {})).toStrictEqual({
      HOME: '/home/agent',
      CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1',
    });
  });
});

describe('runClaude', () => {
  it('feeds the prompt on stdin and splits chunked stdout into lines', async () => {
    const fake = fakeClaude([{ lines: ['{"type":"a"}', '{"type":"b"}'], chunkSize: 3, stderr: 'warn\n' }]);
    const lines: string[] = [];
    const run = runClaude({ spawn: fake.spawn, args: ['-p', '-'], cwd: '/w', env: {}, prompt: 'hi', onLine: l => lines.push(l) });

    const exit = await run.exited;
    expect(lines).toEqual(['{"type":"a"}', '{"type":"b"}']);
    expect(exit).toMatchObject({ exitCode: 0, stderr: 'warn\n', timedOut: false, terminated: false });
    expect(fake.calls[0]).toMatchObject({ command: 'claude', stdin: 'hi', cwd: '/w', detached: false });
    expect(run.isAlive()).toBe(false);
  });

  it('terminates a turn that outlives its budget', async () => {
    const fake = fakeClaude([{ lines: [], hang: true }]);
    const run = runClaude({ spawn: fake.spawn, args: [], cwd: '/w', env: {}, prompt: '', onLine: () => {}, timeoutMs: 20 });

    expect(await run.exited).toMatchObject({ timedOut: true, terminated: true, signal: 'SIGTERM' });
    expect(fake.calls[0]!.killed).toEqual(['SIGTERM']);
  });

  it('reports a spawn that throws as a spawn error', async () => {
    const run = runClaude({
      spawn: () => {
        throw new Error('ENOENT');
      },
      args: [],
      cwd: '/w',
      env: {},
      prompt: '',
      onLine: () => {},
    });
    expect((await run.exited).spawnError?.message).toBe('ENOENT');
  });
});


describe('runClaude process handling', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const run = (spawn: ClaudeSpawn, extra: Partial<Parameters<typeof runClaude>[0]> = {}) =>
    runClaude({ spawn, args: [], cwd: '/w', env: { PATH: '/bin' }, prompt: 'hi', onLine: () => {}, ...extra });

  it('spawns the CLI with three pipes in the turn directory and environment', () => {
    const scripted = scriptedChild();
    const options: unknown[] = [];
    run((command, args, spawnOptions) => {
      options.push({ command, args, ...spawnOptions });
      return scripted.spawn(command, args, spawnOptions);
    }, { args: ['-p', '-'] });
    expect(options).toEqual([
      { command: 'claude', args: ['-p', '-'], cwd: '/w', env: { PATH: '/bin' }, detached: false, stdio: ['pipe', 'pipe', 'pipe'] },
    ]);
  });

  it('reports a spawn that throws as a finished run that cannot be stopped', async () => {
    const error = new Error('ENOENT');
    const failed = run(() => {
      throw error;
    });
    failed.terminate();
    expect(failed.pid).toBeUndefined();
    expect(failed.isAlive()).toBe(false);
    expect(await failed.exited).toEqual({ exitCode: null, signal: null, stderr: '', timedOut: false, terminated: false, spawnError: error });
  });

  it('wraps a non-Error spawn failure', async () => {
    const failed = run(() => {
      throw 'no binary';
    });
    expect((await failed.exited).spawnError).toEqual(new Error('no binary'));
  });

  it('reports a process error as a spawn error', async () => {
    const scripted = scriptedChild();
    const turn = run(scripted.spawn);
    const error = new Error('EACCES');
    scripted.child.emit('error', error);
    expect(await turn.exited).toEqual({ exitCode: null, signal: null, stderr: '', timedOut: false, terminated: false, spawnError: error });
    expect(turn.isAlive()).toBe(false);
  });

  it('reads stdout and stderr as UTF-8 and delivers a last line without a newline on exit', async () => {
    const scripted = scriptedChild();
    const lines: string[] = [];
    const turn = run(scripted.spawn, { onLine: line => lines.push(line) });
    scripted.stdout.emit('data', '{"a":1}\n{"b"');
    scripted.stdout.emit('data', ':2}');
    expect(lines).toEqual(['{"a":1}']);
    scripted.child.emit('close', 0, null);
    expect(await turn.exited).toEqual({ exitCode: 0, signal: null, stderr: '', timedOut: false, terminated: false });
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
    expect(scripted.stdout.encodings).toEqual(['utf8']);
    expect(scripted.stderr.encodings).toEqual(['utf8']);
    expect(scripted.stdin.written).toEqual([
      `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' }, parent_tool_use_id: null })}\n`,
    ]);
    expect(scripted.stdin.ended).toBe(false);
  });

  it('keeps stdin open for more stream-json messages until the input is closed', async () => {
    const scripted = scriptedChild();
    const turn = run(scripted.spawn);
    expect(turn.acceptsInput()).toBe(true);
    expect(turn.send({ type: 'user', message: { role: 'user', content: 'steer' } })).toBe(true);
    expect(scripted.stdin.written[1]).toBe('{"type":"user","message":{"role":"user","content":"steer"}}\n');
    turn.closeInput();
    turn.closeInput();
    expect(scripted.stdin.ended).toBe(true);
    expect(turn.acceptsInput()).toBe(false);
    expect(turn.send({ type: 'user' })).toBe(false);
    expect(scripted.stdin.written).toHaveLength(2);
    scripted.child.emit('close', 0, null);
    await turn.exited;
  });

  it('takes no more input once the process exited, its pipe broke or a write failed', async () => {
    const exited = scriptedChild();
    const done = run(exited.spawn);
    exited.child.emit('close', 0, null);
    await done.exited;
    expect(done.send({ type: 'user' })).toBe(false);

    const broken = scriptedChild();
    const piped = run(broken.spawn);
    broken.stdin.emit('error', new Error('EPIPE'));
    expect(piped.acceptsInput()).toBe(false);
    expect(piped.send({ type: 'user' })).toBe(false);
    piped.terminate();

    const failing = scriptedChild();
    const throwing = run(failing.spawn);
    failing.stdin.failWrites = true;
    expect(throwing.send({ type: 'user' })).toBe(false);
    expect(throwing.acceptsInput()).toBe(false);
    throwing.terminate();

    const noPipes = run(scriptedChild({ pipes: false }).spawn);
    expect(noPipes.acceptsInput()).toBe(false);
    noPipes.closeInput();
    noPipes.terminate();

    const never = run(() => {
      throw new Error('ENOENT');
    });
    expect([never.send({}), never.acceptsInput()]).toEqual([false, false]);
    never.closeInput();
    never.pauseTimeout();
    never.resumeTimeout();
  });

  it('pauses the time budget while a turn waits and restarts it in full', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const scripted = scriptedChild();
    const turn = run(scripted.spawn, { timeoutMs: 100 });
    vi.advanceTimersByTime(90);
    turn.pauseTimeout();
    vi.advanceTimersByTime(1_000);
    expect(turn.isAlive()).toBe(true);
    turn.resumeTimeout();
    vi.advanceTimersByTime(99);
    expect(scripted.killed).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(scripted.killed).toEqual(['SIGTERM']);
    expect(await turn.exited).toMatchObject({ timedOut: true, terminated: true });
    turn.resumeTimeout();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores a broken stdin pipe', async () => {
    const scripted = scriptedChild();
    const turn = run(scripted.spawn);
    expect(() => scripted.stdin.emit('error', new Error('EPIPE'))).not.toThrow();
    scripted.child.emit('close', 1, null);
    expect((await turn.exited).exitCode).toBe(1);
  });

  it('runs a child that has no pipes', async () => {
    const scripted = scriptedChild({ pipes: false });
    const turn = run(scripted.spawn);
    scripted.child.emit('close', 0, null);
    expect((await turn.exited).exitCode).toBe(0);
  });

  it('keeps the first 64 KiB of stderr', async () => {
    const scripted = scriptedChild();
    const turn = run(scripted.spawn);
    for (let i = 0; i < 70; i += 1) scripted.stderr.emit('data', 'x'.repeat(1024));
    scripted.child.emit('close', 1, null);
    expect((await turn.exited).stderr).toHaveLength(64 * 1024);
  });

  it('signals an injected child directly, never a process group', async () => {
    const groupKill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const scripted = scriptedChild();
    const turn = run(scripted.spawn);
    turn.terminate();
    expect(await turn.exited).toMatchObject({ signal: 'SIGTERM', terminated: true, timedOut: false });
    expect(scripted.killed).toEqual(['SIGTERM']);
    expect(groupKill).not.toHaveBeenCalled();
  });

  it('stops a turn once, and not after it exited', async () => {
    const scripted = scriptedChild();
    const turn = run(scripted.spawn);
    turn.terminate();
    turn.terminate();
    await turn.exited;
    expect(scripted.killed).toEqual(['SIGTERM']);

    const done = scriptedChild();
    const finished = run(done.spawn);
    done.child.emit('close', 0, null);
    await finished.exited;
    finished.terminate();
    expect(done.killed).toEqual([]);
  });

  it('kills a turn that ignores SIGTERM after the grace period', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const scripted = scriptedChild({ exitOn: ['SIGKILL'] });
    const turn = run(scripted.spawn, { killGraceMs: 50 });
    turn.terminate();
    vi.advanceTimersByTime(49);
    expect(scripted.killed).toEqual(['SIGTERM']);
    expect(turn.isAlive()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(scripted.killed).toEqual(['SIGTERM', 'SIGKILL']);
    expect(await turn.exited).toEqual({ exitCode: null, signal: 'SIGKILL', stderr: '', timedOut: false, terminated: true });
  });

  it('waits five seconds before killing by default', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const scripted = scriptedChild({ exitOn: ['SIGKILL'] });
    const turn = run(scripted.spawn);
    turn.terminate();
    vi.advanceTimersByTime(4_999);
    expect(scripted.killed).toEqual(['SIGTERM']);
    vi.advanceTimersByTime(1);
    expect(scripted.killed).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('leaves no timers behind once the turn exits', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const scripted = scriptedChild();
    const turn = run(scripted.spawn, { timeoutMs: 60_000, killGraceMs: 1_000 });
    turn.terminate();
    await turn.exited;
    expect(vi.getTimerCount()).toBe(0);

    const quiet = scriptedChild();
    const finished = run(quiet.spawn, { timeoutMs: 60_000 });
    quiet.child.emit('close', 0, null);
    expect(await finished.exited).toMatchObject({ timedOut: false, terminated: false });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('has no time budget unless it is positive', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    for (const timeoutMs of [undefined, 0, -1]) {
      const scripted = scriptedChild();
      const turn = run(scripted.spawn, timeoutMs === undefined ? {} : { timeoutMs });
      vi.advanceTimersByTime(60_000);
      expect(turn.isAlive()).toBe(true);
      expect(scripted.killed).toEqual([]);
      turn.terminate();
    }
  });

  it.skipIf(process.platform === 'win32')('stops the whole process group of a real CLI, including what it started', async () => {
    const lines: string[] = [];
    const turn = runClaude({
      command: '/bin/sh',
      args: ['-c', 'sleep 30 & echo $!; wait'],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
      prompt: '',
      onLine: line => lines.push(line),
    });
    await vi.waitFor(() => expect(lines).toHaveLength(1));
    const sleeper = Number(lines[0]);
    const groupKill = vi.spyOn(process, 'kill');
    try {
      turn.terminate();
      expect(await turn.exited).toMatchObject({ signal: 'SIGTERM', terminated: true });
      expect(groupKill).toHaveBeenCalledWith(-turn.pid!, 'SIGTERM');
      groupKill.mockRestore();
      await vi.waitFor(() => expect(() => process.kill(sleeper, 0)).toThrow(), { timeout: 2_000 });
    } finally {
      try {
        process.kill(sleeper, 'SIGKILL');
      } catch {}
    }
  });
});
