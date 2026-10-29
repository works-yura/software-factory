import { describe, expect, it } from 'vitest';

import { fakeClaude } from './__fixtures__/fake-claude.ts';
import { buildClaudeArgs, buildClaudeEnv, runClaude } from './cli.ts';

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
      '-p',
      '-',
      '--output-format',
      'stream-json',
      '--verbose',
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
