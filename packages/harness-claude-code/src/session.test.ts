import { describe, expect, it } from 'vitest';

import type { AgentEvent, AgentRunEndReason } from '@factory/harness';

import { deferred, fakeClaude, fixture, type FakeTurn } from './__fixtures__/fake-claude.ts';
import { ClaudeCodeError } from './errors.ts';
import { createClaudeCodeHarness, type ClaudeCodeHarnessConfig } from './harness.ts';
import type { ClaudeTranscriptEntry } from './events.ts';
import { GATE_SERVER_SCRIPT, PLANNING_PROMPT } from './gate.ts';
import type { ClaudeCodeSession } from './session.ts';
import { createInMemorySessionStore, type ClaudeSessionStore } from './store.ts';

const CLAUDE_SESSION = '9f0c1a52-6b1e-4d6a-9a43-2f3b8f0e7c11';

async function setup(turns: FakeTurn[], overrides: Partial<ClaudeCodeHarnessConfig> & { store?: ClaudeSessionStore } = {}) {
  const fake = fakeClaude(turns);
  const store = overrides.store ?? createInMemorySessionStore();
  const harness = createClaudeCodeHarness({
    store,
    spawn: fake.spawn,
    credentials: async session => ({ ANTHROPIC_API_KEY: `sk-for-${session.id}` }),
    cwdFor: () => '/work/card-1',
    env: { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'server-key', CLAUDECODE: '1' },
    ...overrides,
  });
  const session = await harness.createSession({ sessionId: 'card-1', threadId: 'thread-1', resourceId: 'fp-1' });
  const events: AgentEvent[] = [];
  session.subscribe(event => events.push(event));
  const transcript: ClaudeTranscriptEntry[] = [];
  session.onTranscript(entry => transcript.push(entry));
  const requestContext = harness.runContext(session, {
    userId: 'user-1',
    orgId: 'org-1',
    threadId: 'thread-1',
    resourceId: 'fp-1',
  });
  const signal = (id: string, contents: string) =>
    session.sendSignal({ id, type: 'user', tagName: 'user', contents }, { requestContext, requireDelivery: true }).accepted;
  return { fake, store, harness, session, events, transcript, signal };
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

const flagValue = (args: string[], flag: string) => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
};

describe('ClaudeCodeSession', () => {
  it('wakes an idle session, runs one turn and ends complete', async () => {
    const { fake, session, events, transcript, signal, store } = await setup([{ lines: fixture('turn-complete.jsonl') }]);
    const end = nextEnd(session);

    const accepted = await signal('kickoff-1', 'Update the README.');
    expect(accepted).toMatchObject({ accepted: true, action: 'wake', runId: expect.any(String) });
    expect(session.run.isRunning()).toBe(true);
    expect(await end).toBe('complete');
    expect(session.run.isRunning()).toBe(false);
    expect(session.stream.isActive()).toBe(false);

    const [call] = fake.calls;
    expect(call!.args.slice(0, 5)).toEqual(['-p', '-', '--output-format', 'stream-json', '--verbose']);
    expect(call!.args).not.toContain('--resume');
    expect(call!.stdin).toBe('Update the README.');
    expect(call!.cwd).toBe('/work/card-1');

    expect(events.map(event => event.type)).toEqual(['usage_update', 'usage_update', 'agent_end']);
    expect(transcript.map(entry => entry.kind)).toEqual(['input', 'init', 'thinking', 'tool_call', 'tool_result', 'text', 'result']);
    expect(transcript[0]).toEqual({ kind: 'input', source: 'signal', text: 'Update the README.', id: 'kickoff-1' });
    expect(await session.thread.listActiveMessages()).toEqual([{ id: 'kickoff-1' }]);
    expect(session.claudeSessionId).toBe(CLAUDE_SESSION);
    expect((await store.get('card-1'))?.threads['thread-1']?.claudeSessionId).toBe(CLAUDE_SESSION);
  });

  it('passes the turn credentials and strips the server’s own credentials and nesting markers', async () => {
    const { fake, session, signal } = await setup([{ lines: fixture('turn-complete.jsonl') }]);
    const end = nextEnd(session);
    await signal('kickoff-1', 'go');
    await end;

    expect(fake.calls[0]!.env).toEqual({ PATH: '/usr/bin', ANTHROPIC_API_KEY: 'sk-for-card-1' });
  });

  it('resumes the Claude session on the next turn', async () => {
    const { fake, session, signal } = await setup(
      [{ lines: fixture('turn-complete.jsonl') }, { lines: fixture('turn-complete.jsonl') }],
      { model: 'claude-sonnet-4-6', effort: 'high', allowedTools: ['Read', 'Edit', 'Bash(git status:*)'] },
    );
    let end = nextEnd(session);
    await signal('one', 'first');
    await end;
    end = nextEnd(session);
    await signal('two', 'second');
    await end;

    const args = fake.calls[1]!.args;
    expect(flagValue(args, '--resume')).toBe(CLAUDE_SESSION);
    expect(flagValue(args, '--model')).toBe('claude-sonnet-4-6');
    expect(flagValue(args, '--effort')).toBe('high');
    expect(flagValue(args, '--allowedTools')).toBe('Read,Edit,Bash(git status:*),mcp__factory_gate__submit_plan');
  });

  it('queues a signal sent mid-turn and runs it as the next turn of the same run', async () => {
    const hold = deferred();
    const { fake, session, events, signal } = await setup([
      { lines: fixture('turn-complete.jsonl'), holdAt: 5, hold: hold.promise },
      { lines: fixture('turn-complete.jsonl') },
    ]);
    const end = nextEnd(session);
    const first = await signal('one', 'first');

    const second = await signal('two', 'and also this');
    expect(second).toMatchObject({ action: 'deliver', runId: first.runId });
    // The dispatcher's replay guard sees the queued signal as landed right away.
    expect(await session.thread.listActiveMessages()).toEqual([{ id: 'one' }, { id: 'two' }]);

    hold.resolve();
    expect(await end).toBe('complete');
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1]!.stdin).toBe('and also this');
    expect(flagValue(fake.calls[1]!.args, '--resume')).toBe(CLAUDE_SESSION);
    // One run, two turns: a single end.
    expect(events.filter(event => event.type === 'agent_end')).toHaveLength(1);
  });

  describe('plan gate', () => {
    async function parkOnPlan(extraTurns: FakeTurn[] = [], first = 'turn-submit-plan.jsonl') {
      const context = await setup([{ lines: fixture(first) }, ...extraTurns], { mode: 'planning' });
      const end = nextEnd(context.session);
      await context.signal('plan-1', 'Plan the README change.');
      expect(await end).toBe('suspended');
      return context;
    }

    it('plans without the CLI plan mode: default permissions, edits denied, planning preamble', async () => {
      const { fake } = await parkOnPlan();
      const [call] = fake.calls;

      expect(flagValue(call!.args, '--permission-mode')).toBe('default');
      expect(call!.args.join(' ')).not.toMatch(/--permission-mode plan/);
      expect(flagValue(call!.args, '--disallowedTools')?.split(',')).toEqual(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
      expect(flagValue(call!.args, '--allowedTools')).toBe('mcp__factory_gate__submit_plan');
      expect(call!.stdin).toBe(`${PLANNING_PROMPT}\n\nPlan the README change.`);
    });

    it('parks the run when Claude calls the gate server’s submit_plan', async () => {
      const { fake, session, events, transcript } = await parkOnPlan();

      expect(fake.calls[0]!.killed).toEqual(['SIGTERM']);
      expect(events.filter(event => event.type !== 'usage_update')).toEqual([
        { type: 'tool_suspended', toolName: 'submit_plan', toolCallId: 'toolu_03Gate' },
        { type: 'agent_end', reason: 'suspended' },
      ]);
      expect(session.suspensions.hasPending()).toBe(true);
      expect(session.run.isRunning()).toBe(false);
      expect(session.pendingPlan).toEqual({
        toolCallId: 'toolu_03Gate',
        toolName: 'mcp__factory_gate__submit_plan',
        title: 'README usage section',
        plan: '1. Add a usage section to README.md\n2. Link it from src/index.ts docs',
      });
      // Nothing Claude did after the plan reaches the thread.
      expect(transcript.at(-1)).toMatchObject({ kind: 'plan', title: 'README usage section', plan: expect.stringContaining('usage section') });
      expect(transcript.some(entry => entry.kind === 'tool_result' && entry.toolCallId === 'toolu_03Gate')).toBe(false);
    });

    it('keeps what the CLI prints while it is stopped out of the transcript', async () => {
      const gateFailed = JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_03Gate', content: 'Connection closed', is_error: true }] },
        parent_tool_use_id: null,
        session_id: CLAUDE_SESSION,
      });
      const { session, transcript, signal } = await setup(
        [{ lines: fixture('turn-submit-plan.jsonl').slice(0, 4), hang: true, linesOnKill: [gateFailed] }],
        { mode: 'planning' },
      );
      const end = nextEnd(session);
      await signal('plan-1', 'Plan it.');
      expect(await end).toBe('suspended');
      expect(transcript.at(-1)).toMatchObject({ kind: 'plan', toolCallId: 'toolu_03Gate' });
    });

    it('still parks on ExitPlanMode, should a CLI offer it', async () => {
      const { events } = await parkOnPlan([], 'turn-plan.jsonl');
      expect(events).toContainEqual({ type: 'tool_suspended', toolName: 'submit_plan', toolCallId: 'toolu_02Plan' });
    });

    it('resumes the session with edits allowed once the plan is approved', async () => {
      const { fake, session, transcript } = await parkOnPlan([{ lines: fixture('turn-complete.jsonl') }]);
      const end = nextEnd(session);
      const before = transcript.length;

      await session.respondToToolSuspension({ resumeData: { action: 'approved' }, toolCallId: 'toolu_03Gate' });

      expect(session.suspensions.hasPending()).toBe(false);
      expect(await end).toBe('complete');
      const resumed = fake.calls[1]!;
      expect(flagValue(resumed.args, '--resume')).toBe(CLAUDE_SESSION);
      expect(flagValue(resumed.args, '--permission-mode')).toBe('acceptEdits');
      expect(resumed.args).not.toContain('--disallowedTools');
      expect(resumed.stdin).toBe('The plan was approved. Implement it.');
      expect(session.mode).toBe('acceptEdits');
      // The decision is recorded as such; the prompt carrying it is not a person's message.
      expect(transcript[before]).toEqual({ kind: 'plan_decision', toolCallId: 'toolu_03Gate', decision: { action: 'approved' } });
      expect(transcript.slice(before).some(entry => entry.kind === 'input')).toBe(false);
    });

    it('resumes in planning with the feedback when the plan is rejected', async () => {
      const { fake, session } = await parkOnPlan([{ lines: fixture('turn-submit-plan.jsonl') }]);
      const end = nextEnd(session);

      await session.respondToToolSuspension({ resumeData: { action: 'rejected', feedback: 'Also update CHANGELOG.md' } });

      expect(await end).toBe('suspended');
      const resumed = fake.calls[1]!;
      expect(flagValue(resumed.args, '--resume')).toBe(CLAUDE_SESSION);
      expect(flagValue(resumed.args, '--permission-mode')).toBe('default');
      expect(flagValue(resumed.args, '--disallowedTools')).toContain('Write');
      expect(resumed.stdin).toContain(PLANNING_PROMPT);
      expect(resumed.stdin).toContain('Also update CHANGELOG.md');
      expect(resumed.stdin).toContain('submit it again with `mcp__factory_gate__submit_plan`');
      expect(session.suspensions.hasPending()).toBe(true);
    });

    it('refuses an answer for another gate', async () => {
      const { session } = await parkOnPlan();
      await expect(
        session.respondToToolSuspension({ resumeData: { action: 'approved' }, toolCallId: 'toolu_other' }),
      ).rejects.toThrow(/waiting on toolu_03Gate/);
      expect(session.suspensions.hasPending()).toBe(true);
    });

    it('cancels the pending gate when new work wakes the session instead', async () => {
      const { session, events, signal } = await parkOnPlan([{ lines: fixture('turn-complete.jsonl') }]);
      const end = nextEnd(session);

      await signal('new-1', 'Forget the plan, just fix the typo.');

      expect(events).toContainEqual({ type: 'tool_suspension_cancelled', toolCallId: 'toolu_03Gate' });
      expect(session.suspensions.hasPending()).toBe(false);
      expect(await end).toBe('complete');
    });

    it('keeps a pending gate across a restart', async () => {
      const { store } = await parkOnPlan();
      const restarted = createClaudeCodeHarness({
        store,
        spawn: fakeClaude([]).spawn,
        credentials: async () => ({}),
        cwdFor: () => '/work/card-1',
      });
      const session = await restarted.getSession('card-1');
      expect(session?.suspensions.hasPending()).toBe(true);
      expect(session?.pendingPlan?.title).toBe('README usage section');
      expect(session?.claudeSessionId).toBe(CLAUDE_SESSION);
    });

    it('enters planning on demand', async () => {
      const { fake, session, signal } = await setup([{ lines: fixture('turn-submit-plan.jsonl') }]);
      await session.setMode('planning');
      const end = nextEnd(session);
      await signal('plan-1', 'Plan it.');
      expect(await end).toBe('suspended');
      expect(flagValue(fake.calls[0]!.args, '--disallowedTools')).toContain('Edit');
    });
  });

  describe('isolation', () => {
    const mcpConfigs = (args: string[]) => {
      const index = args.indexOf('--mcp-config');
      const values: string[] = [];
      for (let i = index + 1; i < args.length && !args[i]!.startsWith('--'); i += 1) values.push(args[i]!);
      return values;
    };

    async function firstCall(overrides: Partial<ClaudeCodeHarnessConfig> = {}) {
      const { fake, session, signal } = await setup([{ lines: fixture('turn-complete.jsonl') }], overrides);
      const end = nextEnd(session);
      await signal('one', 'go');
      await end;
      return fake.calls[0]!;
    }

    it('keeps the person’s settings and MCP servers out and adds the gate server by default', async () => {
      const call = await firstCall();

      expect(flagValue(call.args, '--setting-sources')).toBe('project,local');
      expect(call.args).toContain('--strict-mcp-config');
      expect(JSON.parse(flagValue(call.args, '--settings')!)).toEqual({ plansDirectory: '.claude/plans' });
      expect(call.args).not.toContain('--permission-mode');
      expect(call.args).not.toContain('--disallowedTools');
      expect(mcpConfigs(call.args).map(value => JSON.parse(value))).toEqual([
        { mcpServers: { factory_gate: { type: 'stdio', command: process.execPath, args: [GATE_SERVER_SCRIPT] } } },
      ]);
      expect(flagValue(call.args, '--allowedTools')).toBe('mcp__factory_gate__submit_plan');
      expect(flagValue(call.args, '--append-system-prompt')).toContain('mcp__factory_gate__submit_plan');
    });

    it('merges the configured MCP servers and tools with the gate', async () => {
      const factory = { mcpServers: { factory: { type: 'http', url: 'http://localhost/mcp' } } };
      const call = await firstCall({
        mcpConfig: factory,
        allowedTools: ['Read', 'mcp__factory'],
        appendSystemPrompt: 'You work a Factory card.',
        gateServer: { command: '/opt/node', args: ['/opt/gate.mjs'] },
      });

      expect(mcpConfigs(call.args).map(value => JSON.parse(value))).toEqual([
        factory,
        { mcpServers: { factory_gate: { type: 'stdio', command: '/opt/node', args: ['/opt/gate.mjs'] } } },
      ]);
      expect(flagValue(call.args, '--allowedTools')).toBe('Read,mcp__factory,mcp__factory_gate__submit_plan');
      expect(flagValue(call.args, '--append-system-prompt')).toMatch(/^You work a Factory card\.\n\nPlan approval:/);
    });

    it('can be opted out of', async () => {
      const call = await firstCall({ settingSources: false, strictMcpConfig: false, plansDirectory: false });

      expect(call.args).not.toContain('--setting-sources');
      expect(call.args).not.toContain('--strict-mcp-config');
      expect(call.args).not.toContain('--settings');
    });

    it('sets the session’s config dir; a config dir from the credentials hook wins', async () => {
      const call = await firstCall({ configDir: session => `/srv/claude-config/${session.id}` });
      expect(call.env).toEqual({ PATH: '/usr/bin', ANTHROPIC_API_KEY: 'sk-for-card-1', CLAUDE_CONFIG_DIR: '/srv/claude-config/card-1' });

      const pooled = await firstCall({
        configDir: () => '/srv/claude-config/card-1',
        credentials: async () => ({ CLAUDE_CODE_OAUTH_TOKEN: 'oauth', CLAUDE_CONFIG_DIR: '/pool/a' }),
      });
      expect(pooled.env).toEqual({ PATH: '/usr/bin', CLAUDE_CODE_OAUTH_TOKEN: 'oauth', CLAUDE_CONFIG_DIR: '/pool/a' });

      const unset = await firstCall({ configDir: () => undefined });
      expect(unset.env).not.toHaveProperty('CLAUDE_CONFIG_DIR');
    });
  });

  it('aborts: kills the process, ends aborted at once and forgets queued signals', async () => {
    const { fake, session, events, signal } = await setup([{ lines: fixture('turn-complete.jsonl').slice(0, 2), hang: true }]);
    await signal('one', 'long task');
    await signal('two', 'queued');
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(session.stream.isActive()).toBe(true);

    session.abort();

    expect(events.at(-1)).toEqual({ type: 'agent_end', reason: 'aborted' });
    expect(session.run.isRunning()).toBe(false);
    expect(await session.thread.listActiveMessages()).toEqual([{ id: 'one' }]);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(fake.calls[0]!.killed).toEqual(['SIGTERM']);
    expect(events.filter(event => event.type === 'agent_end')).toHaveLength(1);
  });

  it('starts the next run only after the aborted process exited', async () => {
    const { fake, session, signal } = await setup([
      { lines: [], hang: true },
      { lines: fixture('turn-complete.jsonl') },
    ]);
    await signal('one', 'first');
    session.abort();
    const end = nextEnd(session);
    expect(await signal('two', 'second')).toMatchObject({ action: 'wake' });
    expect(await end).toBe('complete');
    expect(fake.calls).toHaveLength(2);
  });

  it('reports a rate limit as an error with its reset time', async () => {
    const { session, events, signal } = await setup([{ lines: fixture('turn-rate-limit.jsonl'), exitCode: 1 }]);
    const end = nextEnd(session);
    await signal('one', 'go');
    expect(await end).toBe('error');

    const error = events.find(event => event.type === 'error')?.error as ClaudeCodeError;
    expect(error).toBeInstanceOf(ClaudeCodeError);
    expect(error.kind).toBe('rate_limit');
    expect(error.resetsAt).toEqual(new Date(1793116800 * 1000));
    expect(typeof error.retryAfter).toBe('number');
  });

  it('starts a fresh Claude session when the stored one is gone', async () => {
    const { fake, session, signal } = await setup([
      { lines: fixture('turn-complete.jsonl') },
      { lines: fixture('turn-unknown-session.jsonl'), exitCode: 1 },
      { lines: fixture('turn-complete.jsonl') },
    ]);
    let end = nextEnd(session);
    await signal('one', 'first');
    await end;
    end = nextEnd(session);
    await signal('two', 'second');
    expect(await end).toBe('complete');

    expect(flagValue(fake.calls[1]!.args, '--resume')).toBe(CLAUDE_SESSION);
    expect(fake.calls[2]!.args).not.toContain('--resume');
  });

  it('fails the delivery when the credentials hook fails', async () => {
    const { session, events, signal } = await setup([], {
      credentials: async () => {
        throw new Error('No credential available for this org.');
      },
    });
    await expect(signal('one', 'go')).rejects.toThrow('No credential available');
    expect(events.map(event => event.type)).toEqual(['error', 'agent_end']);
    expect(session.run.isRunning()).toBe(false);
    expect(await session.thread.listActiveMessages()).toEqual([]);
  });

  describe('notifications', () => {
    it('persists an idle notification and prepends it to the next turn', async () => {
      const { fake, session, signal } = await setup([{ lines: fixture('turn-complete.jsonl') }]);
      const result = await session.sendNotificationSignal(
        { source: 'factory', kind: 'stage-transition', summary: 'Moved to Review.', payload: { message: 'Moved to Review.' } },
        { ifActive: { behavior: 'deliver' }, ifIdle: { behavior: 'persist' } },
      );
      await result.persisted;
      expect(result.accepted).toBeUndefined();
      expect(fake.calls).toHaveLength(0);

      const end = nextEnd(session);
      await signal('kickoff', 'Review the change.');
      await end;
      expect(fake.calls[0]!.stdin).toBe(
        '<system-notification source="factory" kind="stage-transition">\nMoved to Review.\n</system-notification>\n\nReview the change.',
      );
    });

    it('wakes an idle session and lets the caller wait for the run', async () => {
      const { fake, session } = await setup([{ lines: fixture('turn-complete.jsonl') }]);
      const result = await session.sendNotificationSignal(
        { source: 'factory', kind: 'rule-message', summary: 'CI failed.', priority: 'high', dedupeKey: 'rule-1' },
        { ifActive: { behavior: 'deliver' }, ifIdle: { behavior: 'wake' } },
      );
      const accepted = await result.accepted;
      expect(accepted?.action).toBe('wake');
      expect(await accepted?.output?.consumeStream()).toBe('complete');
      expect(fake.calls[0]!.stdin).toContain('priority="high"');

      // A retry of the same decision is not delivered twice.
      const again = await session.sendNotificationSignal(
        { source: 'factory', kind: 'rule-message', summary: 'CI failed.', dedupeKey: 'rule-1' },
        { ifIdle: { behavior: 'wake' } },
      );
      expect((await again.accepted)?.action).toBe('deliver');
      expect(fake.calls).toHaveLength(1);
    });

    it('delivers into a run in flight', async () => {
      const hold = deferred();
      const { fake, session, signal } = await setup([
        { lines: fixture('turn-complete.jsonl'), holdAt: 5, hold: hold.promise },
        { lines: fixture('turn-complete.jsonl') },
      ]);
      const end = nextEnd(session);
      await signal('one', 'first');
      const result = await session.sendNotificationSignal(
        { source: 'factory', kind: 'rule-message', summary: 'Reviewer left comments.' },
        { ifActive: { behavior: 'deliver' }, ifIdle: { behavior: 'wake' } },
      );
      expect((await result.accepted)?.action).toBe('deliver');
      hold.resolve();
      await end;
      expect(fake.calls[1]!.stdin).toContain('Reviewer left comments.');
    });
  });

  it('keeps settings per thread and persists them', async () => {
    const { session, store } = await setup([]);
    await session.thread.setSetting({ key: 'factoryOpenRuns', value: [{ kickoffId: 'k1' }] });
    expect(await session.thread.getSetting({ key: 'factoryOpenRuns' })).toEqual([{ kickoffId: 'k1' }]);

    await session.thread.switch({ threadId: 'thread-2' });
    expect(session.thread.requireId()).toBe('thread-2');
    expect(await session.thread.getSetting({ key: 'factoryOpenRuns' })).toBeUndefined();
    expect((await store.get('card-1'))?.threads['thread-1']?.settings).toEqual({ factoryOpenRuns: [{ kickoffId: 'k1' }] });
  });

  it('never runs the CLI with permission checks skipped', async () => {
    const { fake, session, signal } = await setup(
      [{ lines: fixture('turn-submit-plan.jsonl') }, { lines: fixture('turn-complete.jsonl') }],
      { mode: 'planning' },
    );
    let end = nextEnd(session);
    await signal('one', 'plan');
    await end;
    end = nextEnd(session);
    await session.respondToToolSuspension({ resumeData: { action: 'approved' } });
    await end;
    for (const call of fake.calls) {
      expect(call.args.join(' ')).not.toMatch(/dangerously|bypassPermissions|--permission-mode plan/);
    }
  });
});
