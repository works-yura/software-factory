// Recorded OpenCode 1.14.39 event streams replayed through a session: what a real `opencode serve`
// sent, in its order, with the answers the harness gives where the recording waited for one.
//
// The streams under `fixtures/t3code/` are t3code's OpenCode replay fixtures (MIT, © T3 Tools Inc.,
// apps/server/src/orchestration-v2/testkit/fixtures/{simple,turn_interrupt,plan_questions,
// opencode_subagent,opencode_child_approval,opencode_running_child_approval}/opencode_transcript.ndjson),
// copied unchanged. See docs/features/harnesses/opencode-test-parity.md.
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentEvent, AgentRunContext } from '@factory/harness';
import type { TranscriptEntry } from '@factory/harness/transcript';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { OpenCodeEvent } from './client.ts';
import { createOpenCodeHarness } from './harness.ts';
import type { OpenCodeSession } from './session.ts';
import { createInMemoryOpenCodeSessionStore } from './store.ts';
import { startFakeOpenCode, type FakeOpenCode } from './testkit.ts';

const context: AgentRunContext = { get: () => undefined };

interface Recording {
  rootSessionId: string;
  childSessionId?: string;
  /** The recorded events, cut where the recording waited for the client's answer. */
  segments: Array<{ events: OpenCodeEvent[]; then?: { type: string; input: Record<string, unknown> } }>;
}

async function recording(name: string): Promise<Recording> {
  const lines = (await readFile(new URL(`./fixtures/t3code/${name}.ndjson`, import.meta.url), 'utf8')).split('\n').filter(Boolean);
  const entries = lines.map(line => JSON.parse(line) as { type: string; frame?: { type: string; event?: OpenCodeEvent; input?: Record<string, unknown> }; metadata?: Record<string, string> });
  const start = entries[0] as unknown as { metadata: { nativeSessionId: string; nativeChildSessionId?: string } };
  const segments: Recording['segments'] = [{ events: [] }];
  for (const entry of entries) {
    if (entry.type === 'emit_inbound' && entry.frame?.type === 'sdk.event' && entry.frame.event) segments.at(-1)!.events.push(entry.frame.event);
    if (entry.type === 'expect_outbound' && (entry.frame?.type === 'permission.reply' || entry.frame?.type === 'question.reply')) {
      segments.at(-1)!.then = { type: entry.frame.type, input: entry.frame.input ?? {} };
      segments.push({ events: [] });
    }
  }
  return { rootSessionId: start.metadata.nativeSessionId, ...(start.metadata.nativeChildSessionId ? { childSessionId: start.metadata.nativeChildSessionId } : {}), segments };
}

let fake: FakeOpenCode;
let root: string;

beforeEach(async () => {
  fake = await startFakeOpenCode();
  // The recording holds OpenCode's own busy and user-message events.
  fake.admitPrompts = false;
  root = await mkdtemp(join(tmpdir(), 'opencode-replay-'));
});

afterEach(async () => {
  await fake.close();
});

/** A session whose prompts replay `rec`: segment by segment, each after the answer the one before waited for. */
async function replaying(
  rec: Recording,
  { held = false }: { held?: boolean } = {},
): Promise<{ session: OpenCodeSession; entries: TranscriptEntry[]; events: AgentEvent[]; release: () => void }> {
  let rootId = '';
  const play = (index: number) => {
    const segment = rec.segments[index];
    if (!segment) return;
    for (const event of segment.events) fake.emit(JSON.parse(JSON.stringify(event).replaceAll(rec.rootSessionId, rootId)) as OpenCodeEvent);
  };
  let next = 0;
  fake.onPrompt = prompt => {
    rootId = prompt.sessionId;
    if (rec.childSessionId) fake.parents.set(rec.childSessionId, rootId);
    if (!held) play(next++);
  };
  fake.onPermissionReply = () => play(next++);
  fake.onQuestionReply = () => play(next++);
  const work = await mkdtemp(join(root, 'work-'));
  const harness = createOpenCodeHarness({
    store: createInMemoryOpenCodeSessionStore(),
    cwdFor: () => work,
    stateRootFor: s => join(root, 'state', s.id),
    spawn: fake.spawn,
    env: { PATH: '/usr/bin', HOME: '/home/agent' },
    turnSelectionFor: () => ({ model: 'openai/gpt-5.4-mini' }),
  });
  const session = await harness.createSession({ sessionId: 'session-1', threadId: 'thread-1' });
  const entries: TranscriptEntry[] = [];
  const events: AgentEvent[] = [];
  session.onTranscript(entry => entries.push(entry));
  session.subscribe(event => events.push(event));
  return { session, entries, events, release: () => play(next++) };
}

const ended = (events: AgentEvent[]) => events.filter(event => event.type === 'agent_end').map(event => (event as { reason?: string }).reason);
const settle = () => new Promise(resolve => setTimeout(resolve, 50));

describe('recorded OpenCode streams', () => {
  it('simple: a text reply completes the turn, its empty reasoning left out, its step counted once', async () => {
    const { session, entries, events } = await replaying(await recording('simple'));
    expect(await session.sendMessage({ content: 'Respond with the following text: fixture simple ok', requestContext: context })).toEqual({ reason: 'complete' });
    expect(entries.filter(entry => entry.kind === 'text')).toEqual([{ kind: 'text', text: 'fixture simple ok', messageId: expect.any(String) }]);
    expect(entries.some(entry => entry.kind === 'thinking')).toBe(false);
    // 571 in + 10240 cache read; 9 out + 17 reasoning.
    expect(events.filter(event => event.type === 'usage_update')).toEqual([
      { type: 'usage_update', usage: { promptTokens: 10811, completionTokens: 26, reasoningTokens: 17, cachedInputTokens: 10240, cacheCreationInputTokens: 0, totalTokens: 10837 } },
    ]);
    expect(ended(events)).toEqual(['complete']);
  });

  it('turn_interrupt: a turn stopped right after its prompt ends aborted, with no error', async () => {
    const rec = await recording('turn_interrupt');
    // Recorded as it happened: the abort went out before OpenCode's first event of the turn.
    const { session, events, release } = await replaying(rec, { held: true });
    const sent = session.sendMessage({ content: 'Start a long answer', requestContext: context });
    while (fake.prompts.length === 0) await new Promise(resolve => setTimeout(resolve, 5));
    session.abort();
    release();
    expect(await sent).toEqual({ reason: 'aborted' });
    await settle();
    expect(fake.aborts).toEqual([fake.prompts[0]!.sessionId]);
    expect(events.some(event => event.type === 'error')).toBe(false);
  });

  it('plan_questions: a question parks the turn as a card, and the choice goes back to OpenCode', async () => {
    const { session, entries, events } = await replaying(await recording('plan_questions'));
    expect(await session.sendMessage({ content: 'Ask me one question', requestContext: context })).toEqual({ reason: 'suspended' });
    const card = session.pendingPermission!;
    expect(card).toMatchObject({
      toolCallId: 'call_XU0dxWGu2ioLZscBtYAIqGfT',
      toolName: 'AskUserQuestion',
      input: { questions: [{ question: 'Should this fixture prefer strict schemas or UI flexibility?', header: 'Schema vs Flexibility', options: [{ label: 'Strict schemas' }, { label: 'UI flexibility' }] }] },
    });
    await session.answerQuestion({ answer: 'Strict schemas', toolCallId: card.toolCallId });
    await settle();
    expect(fake.questionReplies).toEqual([{ requestId: 'que_edc9624d9001e2GFKX724Z8b5Z', answers: [['Strict schemas']] }]);
    // The question is its card, not a second tool card; its result settles the card.
    expect(entries.filter(entry => entry.kind === 'tool_call').map(entry => (entry as { toolName: string }).toolName)).toEqual(['AskUserQuestion']);
    expect(entries).toContainEqual({ kind: 'tool_result', toolCallId: card.toolCallId, content: 'User answered: Strict schemas', isError: false });
    expect(entries.filter(entry => entry.kind === 'text').map(entry => (entry as { text: string }).text)).toEqual(['plan questions fixture complete']);
    expect(ended(events)).toEqual(['suspended', 'complete']);
  });

  it('subagent: the task call is the subagent card, its words stay inside it, the parent replies after', async () => {
    const { session, entries, events } = await replaying(await recording('subagent'));
    expect(await session.sendMessage({ content: 'Delegate', requestContext: context })).toEqual({ reason: 'complete' });
    const calls = entries.filter(entry => entry.kind === 'tool_call');
    expect(calls).toEqual([
      { kind: 'tool_call', toolCallId: 'call_MMPbMUvLDj12T5aimkDZC8Sl', toolName: 'Agent', input: { description: 'Return CHILD_OK', prompt: 'Respond exactly CHILD_OK.', subagent_type: 'general' } },
    ]);
    expect(entries).toContainEqual(expect.objectContaining({ kind: 'tool_result', toolCallId: 'call_MMPbMUvLDj12T5aimkDZC8Sl', isError: false }));
    expect(entries.filter(entry => entry.kind === 'text').map(entry => (entry as { text: string }).text)).toEqual(['PARENT_OK']);
    expect(ended(events)).toEqual(['complete']);
  });

  it('child_approval: a subagent asks before its task call shows; OpenCode is asked whose it is, and the turn parks on it', async () => {
    const rec = await recording('child_approval');
    const { session, entries, events } = await replaying(rec);
    expect(await session.sendMessage({ content: 'Delegate', requestContext: context })).toEqual({ reason: 'suspended' });
    expect(fake.sessionReads).toContain(rec.childSessionId);
    expect(session.pendingPermission).toMatchObject({ toolCallId: 'call_childbash0001', toolName: 'execute_command', input: { command: 'git status' } });
    await session.respondToToolApproval({ approved: true, toolCallId: 'call_childbash0001' });
    await settle();
    expect(fake.permissionReplies).toEqual([{ requestId: 'perm_childbash0001', reply: 'always' }]);
    expect(entries.filter(entry => entry.kind === 'text').map(entry => (entry as { text: string }).text)).toEqual(['PARENT_OK']);
    expect(ended(events)).toEqual(['suspended', 'complete']);
  });

  it('running_child_approval: a running subagent’s command asks under its task call, with the command on the card', async () => {
    const { session, entries, events } = await replaying(await recording('running_child_approval'));
    expect(await session.sendMessage({ content: 'Delegate', requestContext: context })).toEqual({ reason: 'suspended' });
    const command = "printf 'running child approval' > running-child.txt";
    expect(session.pendingPermission).toEqual({ toolCallId: 'call_childbash0002', toolName: 'execute_command', input: { command }, parentToolCallId: 'call_MMPbMUvLDj12T5aimkDZC8Sl' });
    expect(entries).toContainEqual({ kind: 'tool_call', toolCallId: 'call_childbash0002', toolName: 'execute_command', input: { command }, parentToolCallId: 'call_MMPbMUvLDj12T5aimkDZC8Sl' });
    await session.respondToToolApproval({ approved: true, toolCallId: 'call_childbash0002' });
    await settle();
    expect(fake.permissionReplies).toEqual([{ requestId: 'per_childbash0002', reply: 'always' }]);
    expect(entries).toContainEqual(expect.objectContaining({ kind: 'tool_result', toolCallId: 'call_childbash0002', isError: false, parentToolCallId: 'call_MMPbMUvLDj12T5aimkDZC8Sl' }));
    expect(ended(events)).toEqual(['suspended', 'complete']);
  });
});
