import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { SUBMIT_PLAN_TOOL_ID } from '../src/gate.ts';
import type { ClaudeToolPermissions } from '../src/permissions.ts';
import { callToolThenReport, type ModelScript } from './mock-anthropic.ts';
import { PROBES, permissionsAsked, probeScript, SUBAGENT_MARKER, type Probe } from './probes.ts';
import { contractSession, OTHER_MCP, TRUSTED_MCP, type ContractSession } from './setup.ts';

let open: ContractSession | undefined;
afterEach(async () => {
  await open?.dispose();
  open = undefined;
});

async function start(
  script: (s: () => ContractSession) => ModelScript,
  permissions: ClaudeToolPermissions,
  config: Parameters<typeof contractSession>[0]['config'] = {},
) {
  let session!: ContractSession;
  session = await contractSession({ script: script(() => session), permissions, config });
  await writeFile(join(session.cwd, 'seed.txt'), 'SEED-CONTENT\n');
  open = session;
  return session;
}

const bash = (command: string): Probe => ({
  category: 'execute',
  tool: 'Bash',
  input: () => ({ command, description: 'contract' }),
  ran: () => false,
});
const lastResult = (s: ContractSession) => {
  const results = s.transcript.filter(entry => entry.kind === 'tool_result' && entry.parentToolCallId === undefined);
  return results.at(-1) as { content: string; isError: boolean } | undefined;
};

describe('a card run nobody attends (unattended)', () => {
  const unattended: ClaudeToolPermissions = { unattended: true };

  it('reads without asking', async () => {
    const s = await start(get => probeScript(PROBES.read, get), unattended);
    expect(await s.say('Go.')).toBe('complete');
    expect(PROBES.read.ran(s)).toBe(true);
    expect(permissionsAsked(s)).toEqual([]);
  });

  it('runs git in the shell without asking', async () => {
    const s = await start(get => probeScript(bash('git --version'), get), unattended);
    expect(await s.say('Go.')).toBe('complete');
    expect(lastResult(s)).toMatchObject({ isError: false, content: expect.stringContaining('git version') });
  });

  it.each(['execute', 'edit', 'mcp'] as const)('refuses %s at once and goes on, never parking', async category => {
    const probe = PROBES[category];
    const s = await start(get => probeScript(probe, get), unattended);
    expect(await s.say('Go.')).toBe('complete');
    expect(probe.ran(s)).toBe(false);
    expect(permissionsAsked(s)).toEqual([]);
    expect(lastResult(s)).toMatchObject({ isError: true, content: expect.stringContaining('nobody is attending this run') });
  });

  it('refuses the rest of Other (a web fetch) at once', async () => {
    const fetch: Probe = { category: 'other', tool: 'WebFetch', input: () => ({ url: 'http://127.0.0.1:9/x', prompt: 'x' }), ran: () => false };
    const s = await start(get => probeScript(fetch, get), unattended);
    expect(await s.say('Go.')).toBe('complete');
    expect(permissionsAsked(s)).toEqual([]);
    expect(lastResult(s)).toMatchObject({ isError: true, content: expect.stringContaining('nobody is attending this run') });
  });

  it('starts a subagent, whose own calls the settings ask about are refused without parking', async () => {
    const s = await start(
      get => turn => {
        if (turn.has(SUBAGENT_MARKER)) return callToolThenReport('Bash', PROBES.execute.input(get()))(turn);
        return callToolThenReport('Agent', PROBES.other.input(get()))(turn);
      },
      unattended,
    );
    expect(await s.say('Delegate.')).toBe('complete');
    expect(permissionsAsked(s)).toEqual([]);
    expect(PROBES.execute.ran(s)).toBe(false);
    const inner = s.transcript.find(entry => entry.kind === 'tool_result' && entry.parentToolCallId !== undefined);
    expect(inner).toMatchObject({ isError: true, content: expect.stringContaining('nobody is attending this run') });
  });

  it('never starts a subagent when Other is denied', async () => {
    const s = await start(get => probeScript(PROBES.other, get), { unattended: true, categories: { other: 'deny' } });
    expect(await s.say('Go.')).toBe('complete');
    expect(PROBES.other.ran(s)).toBe(false);
  });

  it('still uses the Factory’s own tools', async () => {
    const trusted: Probe = { ...PROBES.mcp, tool: `mcp__${TRUSTED_MCP}__echo` };
    const s = await start(get => probeScript(trusted, get), unattended);
    expect(await s.say('Go.')).toBe('complete');
    expect(s.echoed(TRUSTED_MCP)).toEqual(['PROBE']);
  });
});

describe('permission modes do not override the settings', () => {
  it('acceptEdits still asks for an edit the settings say to ask about', async () => {
    const s = await start(get => probeScript(PROBES.edit, get), { categories: { edit: 'ask' } }, { mode: 'acceptEdits' });
    expect(await s.say('Go.')).toBe('suspended');
    expect(PROBES.edit.ran(s)).toBe(false);
  });

  it('acceptEdits still asks before a file-changing shell command when Execute says ask', async () => {
    const mkdir: Probe = { ...bash('mkdir made-by-shell'), ran: s => existsSync(join(s.cwd, 'made-by-shell')) };
    const s = await start(get => probeScript(mkdir, get), { categories: { execute: 'ask' } }, { mode: 'acceptEdits' });
    expect(await s.say('Go.')).toBe('suspended');
    expect(mkdir.ran(s)).toBe(false);
  });

  it('auto-approve runs every category without asking', async () => {
    for (const probe of Object.values(PROBES)) {
      const s = await start(get => probeScript(probe, get), { yolo: true, categories: { read: 'deny' } });
      expect(await s.say('Go.'), probe.tool).toBe('complete');
      expect(probe.ran(s), probe.tool).toBe(true);
      await s.dispose();
      open = undefined;
    }
  });
});

describe('ask each time (the Factory chat’s write tools)', () => {
  it('asks for a trusted Factory tool on every call, even though the server allows the Factory tools', async () => {
    const tool = `mcp__${TRUSTED_MCP}__echo`;
    const probe: Probe = { ...PROBES.mcp, tool };
    const s = await start(get => probeScript(probe, get), { categories: { mcp: 'allow' }, askEachTime: [tool] });
    expect(await s.say('Go.')).toBe('suspended');
    expect(s.session.pendingPermission).toMatchObject({ toolName: tool, once: true });
    expect(s.echoed(TRUSTED_MCP)).toEqual([]);

    expect(await s.answer(true)).toBe('complete');
    expect(s.echoed(TRUSTED_MCP)).toEqual(['PROBE']);
    // Allowed once: the next call asks again.
    expect(await s.say('Again.')).toBe('suspended');
    expect(s.echoed(TRUSTED_MCP)).toEqual(['PROBE']);
  });
});

describe('planning against the real CLI', () => {
  const planner: (get: () => ContractSession) => ModelScript = get => turn => {
    if (turn.lastPrompt.includes('<factory-mode name="planning">')) {
      const [result] = turn.lastToolResults;
      // First try an edit (denied while planning), then submit the plan.
      if (!result) return { toolUse: { name: 'Write', input: PROBES.edit.input(get()) } };
      return { toolUse: { name: SUBMIT_PLAN_TOOL_ID, input: { plan: '1. Write the file.', title: 'Contract plan' } } };
    }
    return callToolThenReport('Write', PROBES.edit.input(get()))(turn);
  };

  it('denies edits while planning, parks on submit_plan, and edits once the plan is approved', async () => {
    const s = await start(planner, { categories: { edit: 'allow' } }, { mode: 'planning' });
    expect(await s.say('Plan it.')).toBe('suspended');
    expect(s.events).toContainEqual(expect.objectContaining({ type: 'tool_suspended', toolName: 'submit_plan' }));
    expect(PROBES.edit.ran(s)).toBe(false);

    const end = new Promise(resolve => {
      const off = s.session.subscribe(event => {
        if (event.type === 'agent_end') {
          off();
          resolve(event.reason);
        }
      });
    });
    await s.session.respondToToolSuspension({ resumeData: { action: 'approved' } });
    expect(await end).toBe('complete');
    expect(PROBES.edit.ran(s)).toBe(true);
  });
});

describe('a subagent’s own calls follow the same settings', () => {
  const delegating = (inner: Probe): ((get: () => ContractSession) => ModelScript) => get => turn => {
    if (turn.has(SUBAGENT_MARKER)) return callToolThenReport(inner.tool, inner.input(get()))(turn);
    return callToolThenReport('Agent', PROBES.other.input(get()))(turn);
  };

  it('never runs a shell command the settings deny, inside a subagent', async () => {
    const s = await start(delegating(PROBES.execute), { categories: { other: 'allow', execute: 'deny' } });
    expect(await s.say('Delegate.')).toBe('complete');
    expect(PROBES.execute.ran(s)).toBe(false);
  });

  it('does not run a shell command the settings ask about, inside a subagent, without a person', async () => {
    const s = await start(delegating(PROBES.execute), { categories: { other: 'allow', execute: 'ask' } });
    const reason = await s.say('Delegate.');
    // The turn parks on the subagent's call, for a person to answer.
    expect(reason).toBe('suspended');
    expect(s.session.pendingPermission).toMatchObject({ toolName: 'Bash', parentToolCallId: expect.any(String) });
    expect(PROBES.execute.ran(s)).toBe(false);
  });

  it('runs a subagent’s allowed shell command', async () => {
    const s = await start(delegating(PROBES.execute), { categories: { other: 'allow', execute: 'allow' } });
    expect(await s.say('Delegate.')).toBe('complete');
    expect(PROBES.execute.ran(s)).toBe(true);
  });
});

describe('what the agent’s shell can see', () => {
  it('keeps server secrets and the turn’s credentials out of the shell environment', async () => {
    const dump: Probe = { ...bash('env > env.txt'), ran: () => true };
    const s = await start(get => probeScript(dump, get), { categories: { execute: 'allow' } }, {
      env: {
        PATH: process.env.PATH,
        HOME: '/nonexistent-home',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        FACTORY_SECRET_PROBE: 'server-secret-value',
        DATABASE_URL: 'postgres://secret',
        ANTHROPIC_API_KEY: 'server-anthropic-key',
        GITLAB_TOKEN: 'server-gitlab-token',
      },
      passEnv: ['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'],
    });
    expect(await s.say('Go.')).toBe('complete');
    const env = await readFile(join(s.cwd, 'env.txt'), 'utf8');
    expect(env).not.toContain('server-secret-value');
    expect(env).not.toContain('postgres://secret');
    expect(env).not.toContain('server-anthropic-key');
    expect(env).not.toContain('server-gitlab-token');
    // The turn's own credential: report what the CLI does with it.
    console.info(env.split('\n').filter(l => /ANTHROPIC|CLAUDE/.test(l)).join(' | '));
    console.info(`turn credential visible to the agent's shell: ${env.includes('sk-ant-contract-test')}`);
  });
});

describe('MCP servers', () => {
  it('lets the trusted Factory server through under every MCP setting, and governs the others', async () => {
    const trusted: Probe = { ...PROBES.mcp, tool: `mcp__${TRUSTED_MCP}__echo` };
    const s = await start(get => probeScript(trusted, get), { categories: { mcp: 'deny' } });
    expect(await s.say('Go.')).toBe('complete');
    expect(s.echoed(TRUSTED_MCP)).toEqual(['PROBE']);
    expect(s.echoed(OTHER_MCP)).toEqual([]);
  });
});

describe('a checkout someone outside wrote (a pull request)', () => {
  async function withRepoHook(settingSourcesFor?: () => []) {
    const s = await start(get => probeScript(PROBES.read, get), { categories: { read: 'allow' } }, settingSourcesFor ? { settingSourcesFor } : {});
    const marker = join(s.root, 'repo-hook-ran');
    await mkdir(join(s.cwd, '.claude'), { recursive: true });
    await writeFile(
      join(s.cwd, '.claude', 'settings.json'),
      JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: `touch ${marker}` }] }] } }),
    );
    expect(await s.say('Go.')).toBe('complete');
    return existsSync(marker);
  }

  it("runs the repository's own hooks under the default settings sources", async () => {
    expect(await withRepoHook()).toBe(true);
  });

  it('runs none of them when the session reads no settings', async () => {
    expect(await withRepoHook(() => [])).toBe(false);
  });
});
