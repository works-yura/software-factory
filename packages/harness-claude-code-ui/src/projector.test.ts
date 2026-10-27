import { describe, expect, it } from 'vitest';

import type { MastraDBMessage } from '@mastra/core/agent-controller';

import { SUBMIT_PLAN_TOOL_ID, type ClaudeTranscriptEntry } from '@factory/harness-claude-code';

import { ClaudeTranscriptProjector, INTERRUPTED, type Projection } from './projector.ts';

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

  it('reports a failed run as an error event', () => {
    const p = projector();
    const out = p.event({ type: 'error', error: new Error('rate limited') });
    expect(out.events).toEqual([{ type: 'error', error: new Error('rate limited') }]);
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
