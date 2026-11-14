import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentEvent, AgentRunContext } from '@factory/harness';
import type { TranscriptEntry } from '@factory/harness/transcript';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createOpenCodeHarness } from './harness.ts';
import type { OpenCodeSession, OpenCodeSessionConfig } from './session.ts';
import { createInMemoryOpenCodeSessionStore } from './store.ts';
import { startFakeOpenCode, type FakeOpenCode } from './testkit.ts';

const context: AgentRunContext = { get: () => undefined };

let fake: FakeOpenCode;
let root: string;

beforeEach(async () => {
  fake = await startFakeOpenCode();
  root = await mkdtemp(join(tmpdir(), 'opencode-session-'));
});

afterEach(async () => {
  await fake.close();
});

async function session(config: Partial<OpenCodeSessionConfig> = {}): Promise<{ session: OpenCodeSession; entries: TranscriptEntry[]; events: AgentEvent[] }> {
  const work = await mkdtemp(join(root, 'work-'));
  const harness = createOpenCodeHarness({
    store: createInMemoryOpenCodeSessionStore(),
    cwdFor: () => work,
    stateRootFor: s => join(root, 'state', s.id),
    spawn: fake.spawn,
    env: { PATH: '/usr/bin', HOME: '/home/agent', OPENCODE_API_KEY: 'never-passed', XDG_DATA_HOME: '/home/agent/.local/share' },
    turnSelectionFor: () => ({ model: 'opencode/big-pickle' }),
    ...config,
  });
  const created = await harness.createSession({ sessionId: 'session-1', threadId: 'thread-1' });
  const entries: TranscriptEntry[] = [];
  const events: AgentEvent[] = [];
  created.onTranscript(entry => entries.push(entry));
  created.subscribe(event => events.push(event));
  return { session: created, entries, events };
}

const ended = (events: AgentEvent[]) => events.filter(event => event.type === 'agent_end').map(event => (event as { reason?: string }).reason);

describe('OpenCodeSession', () => {
  it('runs a turn on the CLI with the picked model, in its own state folders and without the host keys', async () => {
    fake.onPrompt = ({ sessionId }) => {
      fake.say(sessionId, 'Hello there.');
      fake.idle(sessionId);
    };
    const { session: s, entries, events } = await session({ developerInstructions: 'Be a Factory agent.' });
    const result = await s.sendMessage({ content: 'Say hello', requestContext: context });
    expect(result).toEqual({ reason: 'complete' });
    expect(fake.prompts[0]!.input).toMatchObject({ parts: [{ type: 'text', text: 'Say hello' }], agent: 'build', model: { providerID: 'opencode', modelID: 'big-pickle' }, system: 'Be a Factory agent.' });
    expect(entries.map(entry => entry.kind)).toEqual(['input', 'init', 'text_delta', 'text']);
    expect(entries.at(-1)).toMatchObject({ kind: 'text', text: 'Hello there.' });
    expect(ended(events)).toEqual(['complete']);
    const env = fake.spawns[0]!.env;
    expect(env.OPENCODE_API_KEY).toBeUndefined();
    expect(env.XDG_DATA_HOME).toBe(join(root, 'state', 'session-1', 'data'));
    expect(env.OPENCODE_SERVER_PASSWORD).toBeTruthy();
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT!).permission).toMatchObject({ edit: 'ask', bash: 'ask', external_directory: 'ask' });
    // The server ends with the run.
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(fake.alive()).toBe(0);
  });

  it('goes on in the same OpenCode session on the next run, and starts afresh with the history when it is gone', async () => {
    fake.onPrompt = ({ sessionId }) => fake.idle(sessionId);
    const handoffs: string[] = [];
    const { session: s } = await session({
      handoffContextFor: async (_session, request) => {
        handoffs.push(request.reason);
        return request.reason === 'resume_failed' ? { context: '<history>earlier</history>', delivered: async () => {}, unsent: async () => {} } : undefined;
      },
    });
    await s.sendMessage({ content: 'one', requestContext: context });
    const first = s.openCodeSessionId!;
    await s.sendMessage({ content: 'two', requestContext: context });
    expect(fake.prompts[1]!.sessionId).toBe(first);
    fake.sessions.delete(first);
    await s.sendMessage({ content: 'three', requestContext: context });
    expect(s.openCodeSessionId).not.toBe(first);
    expect(handoffs).toEqual(['turn', 'turn', 'resume_failed']);
    expect(fake.prompts[2]!.input.parts[0]!.text).toContain('<history>earlier</history>');
    expect(fake.prompts[2]!.input.parts[0]!.text).toContain('three');
  });

  it('parks on a permission ask and resumes the same turn with the answer', async () => {
    fake.onPrompt = ({ sessionId }) => {
      fake.emit({ type: 'message.updated', properties: { sessionID: sessionId, info: { id: 'msg_a', role: 'assistant' } } });
      fake.emit({
        type: 'message.part.updated',
        properties: { sessionID: sessionId, part: { id: 'prt_t', messageID: 'msg_a', sessionID: sessionId, type: 'tool', tool: 'write', callID: 'call_w', state: { status: 'running', input: { filePath: '/w/hello.txt', content: 'hi' } } } },
      });
      fake.emit({ type: 'permission.asked', properties: { id: 'per_1', sessionID: sessionId, permission: 'edit', patterns: ['hello.txt'], metadata: { diff: '+hi' }, always: [], tool: { messageID: 'msg_a', callID: 'call_w' } } });
    };
    fake.onPermissionReply = (_reply, f) => {
      const sessionId = f.prompts[0]!.sessionId;
      f.emit({
        type: 'message.part.updated',
        properties: { sessionID: sessionId, part: { id: 'prt_t', messageID: 'msg_a', sessionID: sessionId, type: 'tool', tool: 'write', callID: 'call_w', state: { status: 'completed', input: { filePath: '/w/hello.txt', content: 'hi' }, output: 'Wrote file successfully.' } } },
      });
      f.say(sessionId, 'DONE');
      f.idle(sessionId);
    };
    const { session: s, entries, events } = await session();
    expect(await s.sendMessage({ content: 'write it', requestContext: context })).toEqual({ reason: 'suspended' });
    expect(s.pendingPermission).toMatchObject({ toolCallId: 'call_w', toolName: 'write_file' });
    expect(events).toContainEqual({ type: 'tool_suspended', toolName: 'write_file', toolCallId: 'call_w' });
    expect(entries.filter(entry => entry.kind === 'tool_call')).toEqual([{ kind: 'tool_call', toolCallId: 'call_w', toolName: 'write_file', input: { path: '/w/hello.txt', content: 'hi' } }]);
    expect(entries.find(entry => entry.kind === 'permission')).toMatchObject({ toolCallId: 'call_w', input: { diff: '+hi' } });
    await s.respondToToolApproval({ approved: true, toolCallId: 'call_w' });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(fake.permissionReplies).toEqual([{ requestId: 'per_1', reply: 'always' }]);
    expect(fake.prompts).toHaveLength(1);
    expect(entries).toContainEqual({ kind: 'tool_result', toolCallId: 'call_w', content: 'Wrote file successfully.', isError: false });
    expect(entries).toContainEqual({ kind: 'permission_decision', toolCallId: 'call_w', toolName: 'write_file', approved: true });
    expect(ended(events)).toEqual(['suspended', 'complete']);
    expect(s.grantedTools).toEqual(['write_file']);
  });

  it('refuses what an unattended run would ask about instead of parking', async () => {
    fake.onPrompt = ({ sessionId }) => {
      fake.emit({ type: 'permission.asked', properties: { id: 'per_2', sessionID: sessionId, permission: 'bash', patterns: ['rm -rf x'], metadata: { command: 'rm -rf x' }, always: [], tool: { messageID: 'm', callID: 'call_b' } } });
    };
    fake.onPermissionReply = (_reply, f) => f.idle(f.prompts[0]!.sessionId);
    const { session: s, entries } = await session({ policyFor: () => ({ unattended: true }) });
    expect(await s.sendMessage({ content: 'clean up', requestContext: context })).toEqual({ reason: 'complete' });
    expect(fake.permissionReplies).toEqual([{ requestId: 'per_2', reply: 'reject' }]);
    expect(entries.some(entry => entry.kind === 'permission')).toBe(false);
    expect(JSON.parse(fake.spawns[0]!.env.OPENCODE_CONFIG_CONTENT!).permission.bash).toBe('deny');
  });

  it('asks its question as a card and answers OpenCode with the choice', async () => {
    fake.onPrompt = ({ sessionId }) => {
      fake.emit({
        type: 'question.asked',
        properties: { id: 'que_1', sessionID: sessionId, questions: [{ question: 'Which color?', header: 'Color', options: [{ label: 'Red' }, { label: 'Blue' }] }], tool: { messageID: 'm', callID: 'call_q' } },
      });
    };
    fake.onQuestionReply = (_reply, f) => {
      const sessionId = f.prompts[0]!.sessionId;
      f.say(sessionId, 'Blue it is.');
      f.idle(sessionId);
    };
    const { session: s, entries, events } = await session();
    expect(await s.sendMessage({ content: 'paint', requestContext: context })).toEqual({ reason: 'suspended' });
    expect(entries.find(entry => entry.kind === 'tool_call')).toEqual({
      kind: 'tool_call',
      toolCallId: 'call_q',
      toolName: 'AskUserQuestion',
      input: { questions: [{ question: 'Which color?', header: 'Color', options: [{ label: 'Red' }, { label: 'Blue' }] }] },
    });
    await s.answerQuestion({ answer: 'Blue', toolCallId: 'call_q' });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(fake.questionReplies).toEqual([{ requestId: 'que_1', answers: [['Blue']] }]);
    expect(ended(events)).toEqual(['suspended', 'complete']);
  });

  it('fails the run when the free allowance ran out, instead of retrying forever', async () => {
    fake.onPrompt = ({ sessionId }) => {
      fake.emit({ type: 'session.status', properties: { sessionID: sessionId, status: { type: 'retry', attempt: 1, message: 'Free usage limit reached. Free models work in OpenCode', next: 1000 } } });
    };
    const { session: s, events } = await session();
    expect(await s.sendMessage({ content: 'hi', requestContext: context })).toEqual({ reason: 'error' });
    const error = events.find(event => event.type === 'error') as { error: { kind: string } };
    expect(error.error.kind).toBe('rate_limit');
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(fake.aborts).toHaveLength(1);
  });

  it('classifies an error OpenCode reports for the turn', async () => {
    fake.onPrompt = ({ sessionId }) => {
      fake.emit({ type: 'session.error', properties: { sessionID: sessionId, error: { name: 'APIError', data: { message: 'Model is unavailable.', statusCode: 400 } } } });
      fake.idle(sessionId);
    };
    const { session: s, events } = await session();
    expect(await s.sendMessage({ content: 'hi', requestContext: context })).toEqual({ reason: 'error' });
    expect((events.find(event => event.type === 'error') as { error: { kind: string } }).error.kind).toBe('model_unavailable');
  });

  it('stops a turn in flight', async () => {
    fake.onPrompt = () => {};
    const { session: s, events } = await session();
    const sent = s.sendMessage({ content: 'long work', requestContext: context });
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(s.run.isRunning()).toBe(true);
    s.abort();
    expect(await sent).toEqual({ reason: 'aborted' });
    expect(ended(events)).toEqual(['aborted']);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(fake.aborts).toHaveLength(1);
  });

  it('plans with the read-only plan agent and parks on the plan', async () => {
    fake.onPrompt = ({ sessionId }) => {
      fake.say(sessionId, '# Add login\n\n1. Do it.');
      fake.idle(sessionId);
    };
    const { session: s, entries, events } = await session({ mode: 'planning' });
    expect(await s.sendMessage({ content: 'plan login', requestContext: context })).toEqual({ reason: 'suspended' });
    expect(fake.prompts[0]!.input.agent).toBe('plan');
    expect(s.pendingPlan).toMatchObject({ toolName: 'submit_plan', title: 'Add login' });
    expect(entries.some(entry => entry.kind === 'plan')).toBe(true);
    expect(events.some(event => event.type === 'tool_suspended' && event.toolName === 'submit_plan')).toBe(true);
    fake.onPrompt = ({ sessionId }) => fake.idle(sessionId);
    await s.respondToToolSuspension({ resumeData: { action: 'approved' } });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(fake.prompts[1]!.input.agent).toBe('build');
    expect(fake.prompts[1]!.input.parts[0]!.text).toContain('The plan was approved');
  });

  it('runs a message that arrives mid-turn as the next turn of the same run', async () => {
    let turns = 0;
    fake.onPrompt = ({ sessionId }) => {
      turns += 1;
      if (turns === 1) setTimeout(() => fake.idle(sessionId), 80);
      else fake.idle(sessionId);
    };
    const { session: s, events } = await session();
    const first = s.sendMessage({ content: 'one', requestContext: context });
    await new Promise(resolve => setTimeout(resolve, 30));
    await s.sendChatMessage({ content: 'two' });
    expect(await first).toEqual({ reason: 'complete' });
    expect(fake.prompts.map(prompt => prompt.input.parts[0]!.text)).toEqual(['one', 'two']);
    expect(fake.spawns).toHaveLength(1);
    expect(ended(events)).toEqual(['complete']);
  });
});
