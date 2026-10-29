import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { CLAUDE_TOOL_ALIASES, CLAUDE_TOOL_CATEGORY_TOOLS, CLAUDE_UNGOVERNED_TOOLS } from '../src/permissions.ts';
import { startMockAnthropic } from './mock-anthropic.ts';
import { CLAUDE_BIN } from './setup.ts';

const run = promisify(execFile);

/** The built-in tools the CLI under test offers, from its `system init` line. */
async function builtInTools(): Promise<string[]> {
  const mock = await startMockAnthropic(() => ({ text: 'ok' }));
  const root = await mkdtemp(join(tmpdir(), 'claude-contract-'));
  try {
    await mkdir(join(root, 'home'));
    const { stdout } = await run(CLAUDE_BIN, ['-p', 'hi', '--output-format', 'stream-json', '--verbose'], {
      cwd: root,
      timeout: 60_000,
      env: {
        PATH: process.env.PATH,
        HOME: join(root, 'home'),
        CLAUDE_CONFIG_DIR: join(root, 'config'),
        ANTHROPIC_BASE_URL: mock.url,
        ANTHROPIC_API_KEY: 'sk-ant-contract-test',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      },
    });
    const init = stdout
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as { type: string; subtype?: string; tools?: string[] })
      .find(message => message.type === 'system' && message.subtype === 'init');
    return (init?.tools ?? []).filter(tool => !tool.startsWith('mcp__'));
  } finally {
    await mock.close();
    await rm(root, { recursive: true, force: true });
  }
}

describe('the CLI’s tools', () => {
  it('are each governed by a permission category, or reviewed as plumbing', async () => {
    const tools = await builtInTools();
    expect(tools.length).toBeGreaterThan(5);
    const known = new Set([...Object.values(CLAUDE_TOOL_CATEGORY_TOOLS).flat(), ...CLAUDE_UNGOVERNED_TOOLS]);
    // A new tool here needs a decision: which category governs it (permissions.ts), or why none does.
    expect(tools.filter(tool => !known.has(tool))).toEqual([]);
  });

  it('name the subagent tool by a name the alias table knows', async () => {
    const tools = await builtInTools();
    const subagent = tools.filter(tool => tool === 'Agent' || tool === 'Task');
    expect(subagent).toHaveLength(1);
    expect(CLAUDE_TOOL_ALIASES[subagent[0]!]).toBeDefined();
  });
});
