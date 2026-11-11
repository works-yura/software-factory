import { describe, expect, it } from 'vitest';

import type { MastraDBMessage } from '@mastra/core/agent-controller';

import { createNotificationSignal, defaultNotificationDeliveryDecision } from '@mastra/core/notifications';
import { createSignal } from '@mastra/core/signals';

import {
  ClaudeCodeError,
  claudeNotificationDecision,
  SUBMIT_PLAN_TOOL_ID,
  type ClaudeTranscriptEntry,
} from '@factory/harness-claude-code';

import {
  ClaudeTranscriptProjector,
  INTERRUPTED,
  PERMISSION_ALLOWED,
  PERMISSION_DENIED,
  PERMISSION_SUPERSEDED,
  type Projection,
} from './projector.ts';

const RUN = { runId: 'run-1', threadId: 'thread-1' };

function projector() {
  let tick = Date.parse('2026-10-28T10:00:00Z');
  let ids = 0;
  return new ClaudeTranscriptProjector({
    resourceId: 'factory-1',
    // A clock that stands still: the projector must still order what it creates.
    now: () => new Date(tick),
    newId: () => `id-${(ids += 1)}`,
  });
}

/** Feeds entries and collects everything they produced. */
function play(p: ClaudeTranscriptProjector, entries: ClaudeTranscriptEntry[], meta = RUN): Projection {
  const out: Projection = { events: [], writes: [] };
  for (const entry of entries) {
    const next = p.entry(entry, meta);
    out.events.push(...next.events);
    out.writes.push(...next.writes);
  }
  return out;
}

/** The latest stored copy of each message, in the order they were first written. */
function stored(writes: MastraDBMessage[]): MastraDBMessage[] {
  const latest = new Map<string, MastraDBMessage>();
  for (const message of writes) latest.set(message.id, message);
  return [...latest.values()];
}

describe('ClaudeTranscriptProjector', () => {
  it('stamps the model-switch marker on the input that starts a turn on another model or effort', () => {
    const modelSwitch = {
      from: { instanceId: 'claude-code', model: 'opus', options: [{ id: 'effort', value: 'high' }] },
      to: { instanceId: 'claude-code', model: 'sonnet', options: [{ id: 'effort', value: 'medium' }] },
    };
    const out = play(projector(), [{ kind: 'input', source: 'signal', text: 'Go on.', id: 'sig-1', modelSwitch }]);
    expect(stored(out.writes)[0]!.content.metadata).toMatchObject({ modelSwitch, signal: { id: 'sig-1' } });
    expect(out.events.find(event => event.type === 'message_start')).toMatchObject({
      message: { content: { metadata: { modelSwitch } } },
    });
  });

  it('stores a turn as the person’s message and one assistant message with thinking, the tool call and its result, and text', () => {
    const p = projector();
    const out = play(p, [
      { kind: 'input', source: 'signal', text: 'Update the README.', id: 'sig-1' },
      { kind: 'init', sessionId: 'claude-1', model: 'claude-sonnet-4-5' },
      { kind: 'thinking', text: 'Look at the README first.', messageId: 'msg_1' },
      { kind: 'tool_call', toolCallId: 'toolu_1', toolName: 'Read', input: { file_path: 'README.md' } },
      { kind: 'tool_result', toolCallId: 'toolu_1', content: '# Project', isError: false },
      { kind: 'text', text: 'Done.', messageId: 'msg_2' },
      { kind: 'result', subtype: 'success', isError: false, text: 'Done.' },
    ]);

    const [user, assistant, ...rest] = stored(out.writes);
    expect(rest).toEqual([]);
    expect(user).toMatchObject({
      id: 'sig-1',
      role: 'signal',
      threadId: 'thread-1',
      resourceId: 'factory-1',
      content: {
        format: 2,
        parts: [{ type: 'text', text: 'Update the README.' }],
        metadata: { signal: { id: 'sig-1', type: 'user', tagName: 'user' } },
      },
    });
    expect(assistant).toMatchObject({
      id: 'claude-run-1-1',
      role: 'assistant',
      threadId: 'thread-1',
      resourceId: 'factory-1',
      content: {
        format: 2,
        parts: [
          { type: 'reasoning', reasoning: 'Look at the README first.' },
          {
            type: 'tool-invocation',
            toolInvocation: {
              state: 'result',
              toolCallId: 'toolu_1',
              toolName: 'Read',
              args: { file_path: 'README.md' },
              result: '# Project',
            },
          },
          { type: 'text', text: 'Done.' },
        ],
      },
    });
    expect(new Date(assistant!.createdAt).getTime()).toBeGreaterThan(new Date(user!.createdAt).getTime());
    expect(p.modelId).toBe('claude-sonnet-4-5');

    expect(out.events.map(event => event.type)).toEqual([
      'agent_start',
      'message_start', // the person's message
      'message_end',
      'message_start', // the assistant message
      'message_update', // thinking
      'message_update', // tool call
      'tool_start',
      'message_update', // tool result
      'tool_end',
      'message_update', // text
      'message_end',
    ]);
    expect(out.events).toContainEqual({ type: 'tool_end', toolCallId: 'toolu_1', result: '# Project', isError: false });
  });

  it('grows one message from streaming deltas and stores the full block under the same id and part', () => {
    const p = projector();
    const out = play(p, [
      { kind: 'input', source: 'signal', text: 'Hi', id: 'sig-1' },
      { kind: 'thinking_delta', text: 'Hmm' },
      { kind: 'thinking_delta', text: ', greet.' },
      { kind: 'thinking', text: 'Hmm, greet.' },
      { kind: 'text_delta', text: 'Hel' },
      { kind: 'text_delta', text: 'lo' },
    ]);
    const assistantId = 'claude-run-1-1';
    expect(out.events.filter(event => event.type === 'message_update')).toEqual([
      { type: 'message_update', id: assistantId, event: { type: 'part', index: 0, part: expect.objectContaining({ type: 'reasoning', reasoning: '' }) } },
      { type: 'message_update', id: assistantId, event: { type: 'reasoning-delta', index: 0, delta: 'Hmm' } },
      { type: 'message_update', id: assistantId, event: { type: 'reasoning-delta', index: 0, delta: ', greet.' } },
      { type: 'message_update', id: assistantId, event: { type: 'part', index: 0, part: expect.objectContaining({ reasoning: 'Hmm, greet.' }) } },
      { type: 'message_update', id: assistantId, event: { type: 'part', index: 1, part: { type: 'text', text: '' } } },
      { type: 'message_update', id: assistantId, event: { type: 'text-delta', delta: 'Hel' } },
      { type: 'message_update', id: assistantId, event: { type: 'text-delta', delta: 'lo' } },
    ]);
    // Deltas are live only; the store sees the confirmed block.
    expect(stored(out.writes).find(message => message.id === assistantId)?.content.parts).toEqual([
      { type: 'reasoning', reasoning: 'Hmm, greet.', details: [{ type: 'text', text: 'Hmm, greet.' }] },
    ]);
    expect(p.currentMessage?.content.parts.at(-1)).toEqual({ type: 'text', text: 'Hello' });

    const done = play(p, [{ kind: 'text', text: 'Hello!' }, { kind: 'result', subtype: 'success', isError: false }]);
    const [message] = stored(done.writes);
    expect(message?.id).toBe(assistantId);
    expect(message?.content.parts.map(part => part.type)).toEqual(['reasoning', 'text']);
    expect(message?.content.parts[1]).toEqual({ type: 'text', text: 'Hello!' });
    expect(done.events.at(-1)).toEqual({ type: 'message_end', id: assistantId });
  });

  it('matches full blocks to the parts they streamed into even when all deltas come first', () => {
    const p = projector();
    const out = play(p, [
      { kind: 'thinking_delta', text: 'think' },
      { kind: 'text_delta', text: 'say' },
      { kind: 'thinking', text: 'think more' },
      { kind: 'text', text: 'say more' },
    ]);
    expect(stored(out.writes)[0]?.content.parts).toEqual([
      { type: 'reasoning', reasoning: 'think more', details: [{ type: 'text', text: 'think more' }] },
      { type: 'text', text: 'say more' },
    ]);
  });

  it('starts a new assistant message after each input, and pairs a result with a call from an earlier message', () => {
    const p = projector();
    const out = play(p, [
      { kind: 'input', source: 'signal', text: 'Run the tests', id: 'sig-1' },
      { kind: 'tool_call', toolCallId: 'toolu_1', toolName: 'Bash', input: { command: 'pnpm test' } },
      { kind: 'input', source: 'notification', text: '<system-notification source="github" kind="ci">\nCI failed\n</system-notification>' },
      { kind: 'tool_result', toolCallId: 'toolu_1', content: 'exit 1', isError: true },
      { kind: 'text', text: 'Tests fail.' },
    ]);
    const messages = stored(out.writes);
    expect(messages.map(message => message.id)).toEqual(['sig-1', 'claude-run-1-1', 'id-1', 'claude-run-1-2']);
    expect(messages[1]?.content.parts[0]).toMatchObject({
      type: 'tool-invocation',
      toolInvocation: { state: 'result', toolCallId: 'toolu_1', result: 'exit 1', isError: true },
    });
    expect(messages[2]).toMatchObject({
      role: 'signal',
      content: {
        parts: [{ type: 'text', text: 'CI failed' }],
        metadata: { signal: { type: 'reactive', tagName: 'notification', attributes: { source: 'github', kind: 'ci' } } },
      },
    });
    expect(messages[3]?.content.parts).toEqual([{ type: 'text', text: 'Tests fail.' }]);
  });

  it('keeps subagent output out of the thread', () => {
    const p = projector();
    const out = play(p, [
      { kind: 'tool_call', toolCallId: 'toolu_task', toolName: 'Task', input: { prompt: 'look around' } },
      { kind: 'text', text: 'subagent says', parentToolCallId: 'toolu_task' },
      { kind: 'tool_call', toolCallId: 'toolu_sub', toolName: 'Read', input: {}, parentToolCallId: 'toolu_task' },
      { kind: 'tool_result', toolCallId: 'toolu_task', content: 'found it', isError: false },
    ]);
    expect(stored(out.writes)[0]?.content.parts).toEqual([
      expect.objectContaining({ toolInvocation: expect.objectContaining({ toolCallId: 'toolu_task', state: 'result' }) }),
    ]);
  });

  describe('plan gate', () => {
    const plan = { title: 'README usage section', plan: '1. Add usage\n2. Link it' };

    function parked() {
      const p = projector();
      const out = play(p, [
        { kind: 'input', source: 'signal', text: 'Plan the README change.', id: 'sig-1' },
        { kind: 'text', text: 'Here is my plan.' },
        { kind: 'tool_call', toolCallId: 'toolu_gate', toolName: SUBMIT_PLAN_TOOL_ID, input: plan },
        { kind: 'plan', toolCallId: 'toolu_gate', toolName: SUBMIT_PLAN_TOOL_ID, ...plan },
      ]);
      const gate = { toolCallId: 'toolu_gate', toolName: SUBMIT_PLAN_TOOL_ID, ...plan };
      for (const event of [{ type: 'tool_suspended', toolName: 'submit_plan', toolCallId: 'toolu_gate' }, { type: 'agent_end', reason: 'suspended' }] as const) {
        const next = p.event(event, gate);
        out.events.push(...next.events);
        out.writes.push(...next.writes);
      }
      return { p, out };
    }

    it('draws the gate as the UI’s submit_plan card and stores the pending suspension', () => {
      const { p, out } = parked();
      const assistant = stored(out.writes).find(message => message.role === 'assistant')!;
      expect(assistant.content.parts[1]).toMatchObject({
        type: 'tool-invocation',
        toolInvocation: { state: 'call', toolCallId: 'toolu_gate', toolName: 'submit_plan', args: plan },
      });
      expect(assistant.content.metadata?.suspendedTools).toEqual({
        toolu_gate: { toolCallId: 'toolu_gate', toolName: 'submit_plan', args: plan, suspendPayload: plan },
      });
      expect(out.events).toContainEqual({ type: 'tool_start', toolCallId: 'toolu_gate', toolName: 'submit_plan', args: plan });
      expect(out.events).toContainEqual({
        type: 'tool_suspended',
        toolCallId: 'toolu_gate',
        toolName: 'submit_plan',
        args: plan,
        suspendPayload: plan,
      });
      expect(out.events.at(-1)).toEqual({ type: 'agent_end', reason: 'suspended' });
      // The parked plan is not an interrupted call.
      expect(out.events.some(event => event.type === 'tool_end')).toBe(false);
      expect(p.pendingSuspension).toEqual({ toolCallId: 'toolu_gate', toolName: 'submit_plan', args: plan, suspendPayload: plan });
      expect(p.running).toBe(false);
    });

    it('settles the card with the decision, so the history replays the plan and the feedback', () => {
      const { p } = parked();
      const out = play(p, [
        { kind: 'plan_decision', toolCallId: 'toolu_gate', decision: { action: 'rejected', feedback: 'Also CHANGELOG' } },
      ], { runId: 'run-2', threadId: 'thread-1' });
      const [assistant] = stored(out.writes);
      expect(assistant?.content.metadata?.suspendedTools).toBeUndefined();
      expect(assistant?.content.parts[1]).toMatchObject({
        toolInvocation: {
          state: 'result',
          toolName: 'submit_plan',
          result: { action: 'rejected', submittedPlan: { ...plan, feedback: 'Also CHANGELOG' } },
        },
      });
      expect(out.events.map(event => event.type)).toEqual(['agent_start', 'message_update', 'tool_end']);
      expect(p.pendingSuspension).toBeUndefined();
    });

    it('settles the card as superseded when new work replaces the plan', () => {
      const { p } = parked();
      const out = p.event({ type: 'tool_suspension_cancelled', toolCallId: 'toolu_gate' });
      expect(stored(out.writes)[0]?.content.parts[1]).toMatchObject({
        toolInvocation: { state: 'result', result: { cancelled: 'superseded by new work', submittedPlan: plan } },
      });
      expect(out.events).toContainEqual({
        type: 'tool_suspension_cancelled',
        toolCallId: 'toolu_gate',
        toolName: 'submit_plan',
        reason: 'superseded by new work',
      });
    });

    it('settles a plan parked before a restart once the stored message is adopted', () => {
      const { out } = parked();
      const holder = stored(out.writes).find(message => message.role === 'assistant')!;
      const restarted = projector();
      restarted.adopt(holder, { toolCallId: 'toolu_gate', toolName: SUBMIT_PLAN_TOOL_ID, ...plan });
      expect(restarted.pendingSuspension?.toolCallId).toBe('toolu_gate');
      const decided = play(restarted, [
        { kind: 'plan_decision', toolCallId: 'toolu_gate', decision: { action: 'approved' } },
      ]);
      expect(stored(decided.writes)[0]).toMatchObject({
        id: holder.id,
        content: { parts: [expect.anything(), expect.objectContaining({ toolInvocation: expect.objectContaining({ state: 'result', result: { action: 'approved', submittedPlan: plan } }) })] },
      });
    });
  });

  describe('permission requests', () => {
    const request = { toolCallId: 'toolu_w', toolName: 'Write', input: { file_path: 'x.txt', content: '' } };

    function parked() {
      const p = projector();
      const out = play(p, [
        { kind: 'input', source: 'signal', text: 'Create x.txt', id: 'sig-1' },
        { kind: 'tool_call', toolCallId: 'toolu_w', toolName: 'Write', input: request.input },
        { kind: 'permission', ...request },
      ]);
      for (const event of [{ type: 'tool_suspended', toolName: 'Write', toolCallId: 'toolu_w' }, { type: 'agent_end', reason: 'suspended' }] as const) {
        const next = p.event(event, undefined, request);
        out.events.push(...next.events);
        out.writes.push(...next.writes);
      }
      return { p, out };
    }

    it('asks for approval like a Mastra session and keeps the call open', () => {
      const { p, out } = parked();
      expect(out.events).toContainEqual({ type: 'tool_approval_required', toolCallId: 'toolu_w', toolName: 'Write', args: request.input });
      expect(out.events.some(event => event.type === 'tool_end' || event.type === 'tool_suspended')).toBe(false);
      const assistant = stored(out.writes).find(message => message.role === 'assistant')!;
      expect(assistant.content.metadata?.pendingToolApprovals).toEqual({
        toolu_w: { toolCallId: 'toolu_w', toolName: 'Write', args: request.input },
      });
      expect(p.pendingApproval).toEqual({ toolCallId: 'toolu_w', toolName: 'Write', args: request.input });
    });

    it('settles the call with the answer, or as superseded by new input', () => {
      const denied = play(parked().p, [{ kind: 'permission_decision', toolCallId: 'toolu_w', toolName: 'Write', approved: false }], {
        runId: 'run-2',
        threadId: 'thread-1',
      });
      expect(denied.events).toContainEqual({ type: 'tool_end', toolCallId: 'toolu_w', result: PERMISSION_DENIED, isError: true });
      expect(stored(denied.writes)[0]?.content.metadata?.pendingToolApprovals).toBeUndefined();

      const { p } = parked();
      const superseded = p.event({ type: 'tool_suspension_cancelled', toolCallId: 'toolu_w' });
      expect(superseded.events).toContainEqual({ type: 'tool_end', toolCallId: 'toolu_w', result: PERMISSION_SUPERSEDED, isError: true });
      expect(p.pendingApproval).toBeUndefined();
    });

    it('parks a several-question call as an ask_user card that keeps every question', () => {
      const input = {
        questions: [
          { question: 'Which channels?', header: 'Channels', options: [{ label: 'Push (рекомендовано)' }, { label: 'Email' }] },
          { question: 'Who gets deposit alerts?', options: [{ label: 'Owner' }, { label: 'Everyone' }], multiSelect: true },
        ],
      };
      const ask = { toolCallId: 'toolu_q', toolName: 'AskUserQuestion', input };
      const p = projector();
      const out = play(p, [
        { kind: 'input', source: 'signal', text: 'Plan notifications', id: 'sig-1' },
        { kind: 'tool_call', toolCallId: 'toolu_q', toolName: 'AskUserQuestion', input },
        { kind: 'permission', ...ask },
      ]);
      for (const event of [{ type: 'tool_suspended', toolName: 'AskUserQuestion', toolCallId: 'toolu_q' }, { type: 'agent_end', reason: 'suspended' }] as const) {
        const next = p.event(event, undefined, ask);
        out.events.push(...next.events);
        out.writes.push(...next.writes);
      }

      const suspended = out.events.find(event => event.type === 'tool_suspended') as { toolName: string; suspendPayload: { questions: unknown[] } } | undefined;
      expect(suspended?.toolName).toBe('ask_user');
      expect(suspended?.suspendPayload.questions).toEqual([
        { question: 'Which channels?', header: 'Channels', options: [{ label: 'Push (рекомендовано)' }, { label: 'Email' }] },
        { question: 'Who gets deposit alerts?', options: [{ label: 'Owner' }, { label: 'Everyone' }], multiSelect: true },
      ]);
    });

    it('stores an answered several-question card as answered, so a reload shows it read-only', () => {
      const input = {
        questions: [
          { question: 'Which channels?', options: [{ label: 'Push (рекомендовано)' }, { label: 'Email' }] },
          { question: 'Who gets deposit alerts?', options: [{ label: 'Owner' }, { label: 'Everyone' }] },
        ],
      };
      const ask = { toolCallId: 'toolu_q', toolName: 'AskUserQuestion', input };
      const p = projector();
      const out = play(p, [
        { kind: 'input', source: 'signal', text: 'Plan notifications', id: 'sig-1' },
        { kind: 'tool_call', toolCallId: 'toolu_q', toolName: 'AskUserQuestion', input },
        { kind: 'permission', ...ask },
      ]);
      for (const event of [{ type: 'tool_suspended', toolName: 'AskUserQuestion', toolCallId: 'toolu_q' }, { type: 'agent_end', reason: 'suspended' }] as const) {
        const next = p.event(event, undefined, ask);
        out.events.push(...next.events);
        out.writes.push(...next.writes);
      }
      const answer = '1. Which channels?\n   → Push\n2. Who gets deposit alerts?\n   → Owner';
      const answered = play(p, [{ kind: 'question_answer', toolCallId: 'toolu_q', answer }], { runId: 'run-2', threadId: 'thread-1' });
      const after = play(p, [{ kind: 'text', text: 'Thanks, noted.' }, { kind: 'result' } as ClaudeTranscriptEntry], {
        runId: 'run-2',
        threadId: 'thread-1',
      });
      const end = p.event({ type: 'agent_end' });

      const messages = stored([...out.writes, ...answered.writes, ...after.writes, ...end.writes]);
      const holder = messages.find(message =>
        message.content.parts.some(part => part.type === 'tool-invocation' && part.toolInvocation.toolCallId === 'toolu_q'),
      )!;
      const part = holder.content.parts.find(
        part => part.type === 'tool-invocation' && part.toolInvocation.toolCallId === 'toolu_q',
      ) as { toolInvocation: { state: string; result?: unknown; isError?: boolean; toolName: string } };
      expect(part.toolInvocation).toMatchObject({ state: 'result', result: answer, toolName: 'ask_user' });
      expect(part.toolInvocation.isError).toBeUndefined();
      expect(holder.content.metadata?.suspendedTools).toBeUndefined();
      expect(p.pendingSuspension).toBeUndefined();
    });

    it('settles a request parked before a restart once the stored message is adopted', () => {
      const holder = stored(parked().out.writes).find(message => message.role === 'assistant')!;
      const restarted = projector();
      restarted.adoptPermission(holder, request);
      expect(restarted.pendingApproval?.toolCallId).toBe('toolu_w');
      const allowed = play(restarted, [{ kind: 'permission_decision', toolCallId: 'toolu_w', toolName: 'Write', approved: true }]);
      expect(allowed.events).toContainEqual({ type: 'tool_end', toolCallId: 'toolu_w', result: PERMISSION_ALLOWED, isError: false });
    });
  });

  it('closes the message and settles calls cut off when the run is aborted', () => {
    const p = projector();
    const out = play(p, [
      { kind: 'input', source: 'signal', text: 'Go', id: 'sig-1' },
      { kind: 'tool_call', toolCallId: 'toolu_1', toolName: 'Bash', input: { command: 'sleep 100' } },
    ]);
    const end = p.event({ type: 'agent_end', reason: 'aborted' });
    expect(end.events.map(event => event.type)).toEqual(['message_end', 'message_update', 'tool_end', 'agent_end']);
    expect(end.events).toContainEqual({ type: 'tool_end', toolCallId: 'toolu_1', result: INTERRUPTED, isError: true });
    expect(stored([...out.writes, ...end.writes]).at(-1)?.content.parts[0]).toMatchObject({
      toolInvocation: { state: 'result', result: INTERRUPTED, isError: true },
    });
    expect(p.running).toBe(false);
  });

  it('forwards a step’s token usage as the chat’s usage_update', () => {
    const p = projector();
    const out = p.event({
      type: 'usage_update',
      usage: { promptTokens: 15_817, completionTokens: 31, totalTokens: 15_848, cachedInputTokens: 15_813 },
    });
    expect(out.events).toEqual([
      {
        type: 'usage_update',
        usage: { promptTokens: 15_817, completionTokens: 31, totalTokens: 15_848, cachedInputTokens: 15_813 },
      },
    ]);
    // Counts Claude left out read as zero, as a Mastra step's do.
    expect(p.event({ type: 'usage_update', usage: { completionTokens: 5 } }).events).toEqual([
      { type: 'usage_update', usage: { promptTokens: 0, completionTokens: 5, totalTokens: 5 } },
    ]);
  });

  it('shows TodoWrite as Mastra’s task_write and tells the task panel, keeping task ids across updates', () => {
    const p = projector();
    const first = play(p, [
      { kind: 'input', source: 'signal', text: 'Plan it', id: 'sig-1' },
      {
        kind: 'tool_call',
        toolCallId: 'toolu_todo1',
        toolName: 'TodoWrite',
        input: {
          todos: [
            { content: 'Read the code', status: 'in_progress', activeForm: 'Reading the code' },
            { content: 'Fix the bug', status: 'pending', activeForm: 'Fixing the bug' },
          ],
        },
      },
      { kind: 'tool_result', toolCallId: 'toolu_todo1', content: 'Todos have been modified successfully.', isError: false },
    ]);
    const tasks = p.tasks;
    expect(tasks).toEqual([
      { id: expect.any(String), content: 'Read the code', status: 'in_progress', activeForm: 'Reading the code' },
      { id: expect.any(String), content: 'Fix the bug', status: 'pending', activeForm: 'Fixing the bug' },
    ]);
    expect(first.events).toContainEqual({ type: 'tool_start', toolCallId: 'toolu_todo1', toolName: 'task_write', args: { tasks } });
    expect(first.events).toContainEqual({ type: 'task_updated', tasks });
    // Stored under the task tool's name, which the chat keeps out of the transcript.
    expect(stored(first.writes).at(-1)?.content.parts[0]).toMatchObject({
      toolInvocation: { toolName: 'task_write', args: { tasks }, state: 'result' },
    });

    const second = play(p, [
      {
        kind: 'tool_call',
        toolCallId: 'toolu_todo2',
        toolName: 'TodoWrite',
        input: {
          todos: [
            { content: 'Read the code', status: 'completed', activeForm: 'Reading the code' },
            { content: 'Fix the bug', status: 'in_progress', activeForm: 'Fixing the bug' },
          ],
        },
      },
    ]);
    expect(p.tasks.map(task => [task.id, task.status])).toEqual([
      [tasks[0]!.id, 'completed'],
      [tasks[1]!.id, 'in_progress'],
    ]);
    expect(second.events).toContainEqual({ type: 'task_updated', tasks: p.tasks });
  });

  it('follows a Task subagent live as the chat’s subagent card, from its call to its result', () => {
    let now = Date.parse('2026-10-28T10:00:00Z');
    const p = new ClaudeTranscriptProjector({ resourceId: 'factory-1', now: () => new Date(now) });
    const out = play(p, [
      { kind: 'init', sessionId: 'claude-1', model: 'claude-sonnet-4-6' },
      {
        kind: 'tool_call',
        toolCallId: 'toolu_task',
        toolName: 'Task',
        input: { description: 'Find the config', prompt: 'Find where the config is loaded.', subagent_type: 'Explore' },
      },
      { kind: 'text_delta', text: 'Looking', parentToolCallId: 'toolu_task' },
      { kind: 'text', text: 'Looking', parentToolCallId: 'toolu_task' },
      { kind: 'tool_call', toolCallId: 'toolu_sub', toolName: 'Grep', input: { pattern: 'config' }, parentToolCallId: 'toolu_task' },
      { kind: 'tool_result', toolCallId: 'toolu_sub', content: 'src/config.ts', isError: false, parentToolCallId: 'toolu_task' },
      { kind: 'text', text: 'Found it.', parentToolCallId: 'toolu_task' },
    ]);
    now += 4_000;
    const done = play(p, [{ kind: 'tool_result', toolCallId: 'toolu_task', content: 'In src/config.ts.', isError: false }]);

    expect(out.events.filter(event => event.type.startsWith('subagent_'))).toEqual([
      {
        type: 'subagent_start',
        toolCallId: 'toolu_task',
        agentType: 'Explore',
        task: 'Find where the config is loaded.',
        modelId: 'claude-sonnet-4-6',
      },
      { type: 'subagent_text_delta', toolCallId: 'toolu_task', agentType: 'Explore', textDelta: 'Looking' },
      {
        type: 'subagent_tool_start',
        toolCallId: 'toolu_task',
        agentType: 'Explore',
        subToolName: 'Grep',
        subToolArgs: { pattern: 'config' },
      },
      {
        type: 'subagent_tool_end',
        toolCallId: 'toolu_task',
        agentType: 'Explore',
        subToolName: 'Grep',
        subToolResult: 'src/config.ts',
        isError: false,
      },
      { type: 'subagent_text_delta', toolCallId: 'toolu_task', agentType: 'Explore', textDelta: 'Found it.' },
    ]);
    // The parent call still settles as before, then the card ends with its result.
    expect(done.events.map(event => event.type)).toEqual(['message_update', 'tool_end', 'subagent_end']);
    expect(done.events.at(-1)).toEqual({
      type: 'subagent_end',
      toolCallId: 'toolu_task',
      agentType: 'Explore',
      result: 'In src/config.ts.',
      isError: false,
      durationMs: 4_000,
    });
    // Nothing the subagent did is stored.
    expect(stored([...out.writes, ...done.writes]).flatMap(message => message.content.parts)).toEqual([
      expect.objectContaining({ toolInvocation: expect.objectContaining({ toolCallId: 'toolu_task', toolName: 'Task' }) }),
    ]);
  });

  it('ends a subagent card cut off by an aborted run as failed', () => {
    const p = projector();
    play(p, [{ kind: 'tool_call', toolCallId: 'toolu_agent', toolName: 'Agent', input: { description: 'Look around' } }]);
    const end = p.event({ type: 'agent_end', reason: 'aborted' });
    expect(end.events).toContainEqual(
      expect.objectContaining({ type: 'subagent_end', toolCallId: 'toolu_agent', agentType: 'general-purpose', result: INTERRUPTED, isError: true }),
    );
  });

  it('reports a failed run as an error event', () => {
    const p = projector();
    const out = p.event({ type: 'error', error: new Error('rate limited') });
    expect(out.events[0]).toEqual({ type: 'error', error: new Error('rate limited') });
  });

  describe('Mastra parity', () => {
    it('stores a run’s failure as an error part on its last assistant message, as recordTerminalErrorMessage does (A3)', () => {
      const p = projector();
      const out = play(p, [
        { kind: 'input', source: 'signal', text: 'Go', id: 'sig-1' },
        { kind: 'init', sessionId: 'claude-1', model: 'claude-sonnet-4-6' },
        { kind: 'text', text: 'Working on it.', messageId: 'msg_1' },
        { kind: 'result', subtype: 'error_during_execution', isError: true },
      ]);
      const failure = new ClaudeCodeError('rate_limit', 'Claude AI usage limit reached.', {
        status: 429,
        resetsAt: new Date('2026-10-28T15:00:00Z'),
      });
      const failed = p.event({ type: 'error', error: failure });
      const again = p.event({ type: 'error', error: failure });

      const [, assistant] = stored([...out.writes, ...failed.writes, ...again.writes]);
      expect(assistant!.content.parts).toEqual([
        { type: 'text', text: 'Working on it.' },
        {
          type: 'error',
          error: {
            name: 'ClaudeCodeError',
            message: 'Claude AI usage limit reached.',
            statusCode: 429,
            status: 429,
            kind: 'rate_limit',
            resetsAt: '2026-10-28T15:00:00.000Z',
            modelId: 'claude-sonnet-4-6',
          },
        },
      ]);
    });

    it('stores a failure before Claude said anything on an assistant message of its own (A3)', () => {
      const p = projector();
      const out = play(p, [{ kind: 'input', source: 'signal', text: 'Go', id: 'sig-1' }]);
      const failed = p.event({ type: 'error', error: new Error('No Claude account is connected.') });
      const [, assistant] = stored([...out.writes, ...failed.writes]);
      expect(assistant).toMatchObject({
        role: 'assistant',
        threadId: 'thread-1',
        content: { parts: [{ type: 'error', error: { name: 'Error', message: 'No Claude account is connected.' } }] },
      });
      expect(failed.events.map(event => event.type)).toEqual(['error', 'message_start', 'message_update', 'message_end']);
    });

    it('stamps the model that answered on the reply, as stampResponseModel does (A6)', () => {
      const p = projector();
      const out = play(p, [
        { kind: 'input', source: 'signal', text: 'Go', id: 'sig-1' },
        { kind: 'init', sessionId: 'claude-1', model: 'claude-opus-4-5' },
        { kind: 'text', text: 'Done.', messageId: 'msg_1' },
      ]);
      const [, assistant] = stored(out.writes);
      expect(assistant!.content.metadata).toEqual({ modelId: 'claude-opus-4-5', provider: 'anthropic' });
    });

    it("names the account a reply ran on, as a Mastra reply names its credential", () => {
      const p = projector();
      const out = play(p, [
        { kind: 'input', source: 'signal', text: 'Go', id: 'sig-1' },
        { kind: 'credential', label: 'alice@example.com', ownerId: 'alice' },
        { kind: 'init', sessionId: 'claude-1', model: 'claude-opus-4-5' },
        { kind: 'text', text: 'Done.', messageId: 'msg_1' },
      ]);
      const [, assistant] = stored(out.writes);
      expect(assistant!.content.metadata).toEqual({
        modelId: 'claude-opus-4-5',
        provider: 'anthropic',
        credentialLabel: 'alice@example.com',
        credentialOwnerId: 'alice',
      });
    });

    it('stores a person’s message with its author and an interjection with while-active delivery, as Mastra’s session does (A1, A7)', () => {
      const author = { id: 'user-ada', name: 'Ada' };
      const p = projector();
      const out = play(p, [
        { kind: 'input', source: 'signal', text: 'Also this.', author, delivery: 'while-active' },
      ]);
      const [message] = stored(out.writes);
      const mastra = createSignal({
        id: 'id-1',
        type: 'user',
        tagName: 'user',
        contents: 'Also this.',
        createdAt: message!.createdAt,
        author,
        providerOptions: { mastra: { author: { ...author } } },
        attributes: { delivery: 'while-active' },
      }).toDBMessage({ threadId: 'thread-1', resourceId: 'factory-1' });
      expect(message).toEqual(mastra);
      expect(message!.content.metadata?.signal).toMatchObject({ author, attributes: { delivery: 'while-active' } });
      expect(message!.content.providerMetadata).toEqual({ mastra: { author } });
    });

    it('stores a notification as the signal Mastra creates for a delivered notification record (A4)', () => {
      const p = projector();
      const record = {
        id: 'note-1',
        source: 'github',
        kind: 'pull-request-review',
        priority: 'high' as const,
        summary: 'Review requested on #12.',
        coalescedCount: 1,
        metadata: { repository: 'acme/app', pullRequestNumber: 12, targetUrl: 'https://github.com/acme/app/pull/12' },
        createdAt: '2026-10-28T09:59:00.000Z',
      };
      const out = play(p, [
        { kind: 'input', source: 'notification', text: '<system-notification>…</system-notification>', notification: record },
      ]);
      const [message] = stored(out.writes);
      const received = new Date(record.createdAt);
      const mastra = createNotificationSignal({
        ...record,
        threadId: 'thread-1',
        status: 'delivered',
        createdAt: received,
        updatedAt: received,
      }).toDBMessage({ threadId: 'thread-1', resourceId: 'factory-1' });
      // Same shape as Mastra's, but for the ids and times each one makes up.
      const { id: _id, createdAt: _at, ...expected } = mastra;
      const { signal: mastraSignal } = mastra.content.metadata as { signal: Record<string, unknown> };
      expect(message).toMatchObject({
        ...expected,
        content: {
          ...expected.content,
          metadata: { signal: { ...mastraSignal, id: message!.id, createdAt: (message!.createdAt as Date).toISOString() } },
        },
      });
      expect(message!.content.metadata?.signal).toMatchObject({
        type: 'notification',
        tagName: 'notification',
        attributes: { id: 'note-1', source: 'github', kind: 'pull-request-review', priority: 'high', status: 'delivered' },
        metadata: { repository: 'acme/app', pullRequestNumber: 12, notification: { recordId: 'note-1', signal: 'notification' } },
      });
    });

    it('forwards the follow-up count (A9)', () => {
      const event = { type: 'follow_up_queued', count: 2 };
      expect(projector().event(event).events).toEqual([{ type: 'follow_up_queued', count: 2 }]);
    });
  });

  it('decides notification delivery exactly as Mastra’s default policy does (A5)', () => {
    const now = new Date('2026-10-28T10:00:00Z');
    for (const priority of ['low', 'medium', 'high', 'urgent'] as const) {
      for (const threadState of ['active', 'idle'] as const) {
        const record = { priority } as Parameters<typeof defaultNotificationDeliveryDecision>[0]['record'];
        expect(claudeNotificationDecision({ record: { priority }, threadState, now })).toEqual(
          defaultNotificationDeliveryDecision({ record, threadState, now }),
        );
      }
    }
  });

  it('announces a new run once, however many turns it takes', () => {
    const p = projector();
    const first = play(p, [
      { kind: 'input', source: 'signal', text: 'one', id: 'a' },
      { kind: 'result', subtype: 'success', isError: false },
      { kind: 'input', source: 'signal', text: 'two', id: 'b' },
    ]);
    expect(first.events.filter(event => event.type === 'agent_start')).toHaveLength(1);
  });
});
