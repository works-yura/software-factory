import { describe, expect, it } from 'vitest';

import { codexErrorFromTurn } from './errors.ts';
import { CodexTurnTranslator, codexFileChangeApprovalPrompt } from './events.ts';

const at = { threadId: 'th', turnId: 'tu' };

function translator() {
  const turn = new CodexTurnTranslator({ threadId: 'th' });
  turn.begin('tu');
  return turn;
}

describe('CodexTurnTranslator', () => {
  it("records file changes under the Factory's file tools, one call per file", () => {
    const turn = translator();
    const item = {
      type: 'fileChange' as const,
      id: 'p1',
      status: 'inProgress' as const,
      changes: [
        { path: 'src/new.ts', kind: { type: 'add' as const }, diff: '+export {}' },
        { path: 'src/a.ts', kind: { type: 'update' as const, move_path: null }, diff: '-a\n+b' },
        { path: 'old.ts', kind: { type: 'delete' as const }, diff: '' },
      ],
    };
    expect(turn.itemStarted({ ...at, item })).toEqual([
      { kind: 'tool_call', toolCallId: 'p1', toolName: 'write_file', input: { path: 'src/new.ts', content: 'export {}' } },
      { kind: 'tool_call', toolCallId: 'p1:1', toolName: 'string_replace_lsp', input: { path: 'src/a.ts', diff: '-a\n+b', added_lines: 1, removed_lines: 1 } },
      { kind: 'tool_call', toolCallId: 'p1:2', toolName: 'delete_file', input: { path: 'old.ts' } },
    ]);
    expect(turn.itemCompleted({ ...at, item: { ...item, status: 'completed' } })).toEqual([
      { kind: 'tool_result', toolCallId: 'p1', content: 'Created src/new.ts.', isError: false },
      { kind: 'tool_result', toolCallId: 'p1:1', content: 'Updated src/a.ts.', isError: false },
      { kind: 'tool_result', toolCallId: 'p1:2', content: 'Deleted old.ts.', isError: false },
    ]);
  });

  it('names MCP calls as mcp__server__tool and reads their text result', () => {
    const turn = translator();
    const item = { type: 'mcpToolCall' as const, id: 'm1', server: 'factory', tool: 'factory_bound_work_item', arguments: { id: 1 }, status: 'completed' as const, result: { content: [{ type: 'text', text: 'Card 12' }] } };
    expect(turn.itemCompleted({ ...at, item })).toEqual([
      { kind: 'tool_call', toolCallId: 'm1', toolName: 'mcp__factory__factory_bound_work_item', input: { id: 1 } },
      { kind: 'tool_result', toolCallId: 'm1', content: 'Card 12', isError: false },
    ]);
    const failed = { ...item, id: 'm2', status: 'failed' as const, result: null, error: { message: 'boom' } };
    expect(turn.itemCompleted({ ...at, item: failed }).at(-1)).toEqual({ kind: 'tool_result', toolCallId: 'm2', content: 'boom', isError: true });
  });

  it('records web searches, reasoning and failed commands', () => {
    const turn = translator();
    expect(turn.itemCompleted({ ...at, item: { type: 'webSearch', id: 'w1', query: 'q', action: { type: 'search', queries: ['a', 'b'] } } })).toEqual([
      { kind: 'tool_call', toolCallId: 'w1', toolName: 'web_search', input: { query: 'q' } },
      { kind: 'tool_result', toolCallId: 'w1', content: 'a\nb\nq', isError: false },
    ]);
    expect(turn.reasoningDelta({ itemId: 'r1', delta: 'Thinking' })).toEqual([{ kind: 'thinking_delta', text: 'Thinking' }]);
    expect(turn.itemCompleted({ ...at, item: { type: 'reasoning', id: 'r1', summary: ['Thinking', 'more'] } })).toEqual([
      { kind: 'thinking', text: 'Thinking\n\nmore', messageId: 'r1' },
    ]);
    const command = { type: 'commandExecution' as const, id: 'c1', command: 'pnpm test', cwd: '/w', status: 'completed' as const, aggregatedOutput: 'fail\n', exitCode: 1 };
    expect(turn.itemCompleted({ ...at, item: command }).at(-1)).toEqual({ kind: 'tool_result', toolCallId: 'c1', content: 'fail\n\nExit code 1', isError: true });
  });

  it('shows the plan list as the task panel', () => {
    const turn = translator();
    expect(
      turn.planUpdated({ ...at, explanation: 'Steps', plan: [{ step: 'Read', status: 'completed' }, { step: 'Write', status: 'inProgress' }, { step: 'Test', status: 'pending' }] }),
    ).toEqual([
      {
        kind: 'tool_call',
        toolCallId: 'tu:plan:1',
        toolName: 'task_write',
        input: {
          todos: [
            { content: 'Read', status: 'completed', activeForm: 'Read' },
            { content: 'Write', status: 'in_progress', activeForm: 'Write' },
            { content: 'Test', status: 'pending', activeForm: 'Test' },
          ],
          explanation: 'Steps',
        },
      },
      { kind: 'tool_result', toolCallId: 'tu:plan:1', content: 'Plan updated.', isError: false },
    ]);
  });

  it('decides the outcome from the completed turn', () => {
    const done = translator();
    done.itemCompleted({ ...at, item: { type: 'agentMessage', id: 'a', text: 'All good' } });
    done.complete({ threadId: 'th', turn: { id: 'tu', status: 'completed' } });
    expect(done.outcome()).toEqual({ kind: 'complete', text: 'All good' });

    const interrupted = translator();
    interrupted.complete({ threadId: 'th', turn: { id: 'tu', status: 'interrupted' } });
    expect(interrupted.outcome()).toEqual({ kind: 'aborted' });

    const unfinished = translator();
    expect(unfinished.outcome()).toMatchObject({ kind: 'error', error: { kind: 'process' } });
    expect(unfinished.owns({ threadId: 'other' })).toBe(false);
    expect(unfinished.owns({ threadId: 'th', turnId: 'tu' })).toBe(true);
    expect(unfinished.owns({ threadId: 'th', turnId: 'older' })).toBe(false);
  });

  it('describes a file change approval', () => {
    expect(codexFileChangeApprovalPrompt({ reason: 'Refactor', changes: [{ path: 'b.ts', kind: { type: 'update' }, diff: '' }, { path: 'a.ts', kind: { type: 'add' }, diff: '' }] })).toBe(
      'Refactor\n\nFiles:\nadd a.ts\nupdate b.ts',
    );
  });
});

describe('CodexTurnTranslator subagents, images, terminals and approvals', () => {
  const child = { threadId: 'child-1', turnId: 'ct' };

  it('draws a spawned subagent as an Agent call with its work nested under it, settled by wait (multi-agent v1)', () => {
    const turn = translator();
    const spawn = {
      type: 'collabAgentToolCall' as const,
      id: 'exec-1',
      tool: 'spawnAgent',
      senderThreadId: 'th',
      prompt: 'Read package.json in the workspace.\nReport its scripts.',
      model: 'gpt-test-luna',
      agentsStates: {},
    };
    expect(turn.itemStarted({ ...at, item: { ...spawn, status: 'inProgress', receiverThreadIds: [] } })).toEqual([]);
    expect(turn.itemCompleted({ ...at, item: { ...spawn, status: 'completed', receiverThreadIds: ['child-1'], agentsStates: { 'child-1': { status: 'pendingInit', message: null } } } })).toEqual([
      {
        kind: 'tool_call',
        toolCallId: 'exec-1',
        toolName: 'Agent',
        input: { description: 'Read package.json in the workspace.', prompt: spawn.prompt, subagent_type: 'codex', model: 'gpt-test-luna' },
      },
    ]);
    expect(turn.accepts({ threadId: 'child-1', turnId: 'ct' })).toBe(true);
    expect(turn.owns({ threadId: 'child-1', turnId: 'ct' })).toBe(false);

    // The subagent's own work, under its call.
    const command = { type: 'commandExecution' as const, id: 'exec-5', command: 'cat package.json', cwd: '/w', status: 'inProgress' as const };
    expect(turn.itemStarted({ ...child, item: command })).toEqual([
      { kind: 'tool_call', toolCallId: 'child-1:exec-5', toolName: 'execute_command', input: { command: 'cat package.json', cwd: '/w' }, parentToolCallId: 'exec-1' },
    ]);
    expect(turn.agentMessageDelta({ ...child, itemId: 'm1', delta: 'Scripts: ' })).toEqual([{ kind: 'text_delta', text: 'Scripts: ', parentToolCallId: 'exec-1' }]);
    expect(turn.reasoningDelta({ ...child, itemId: 'r1', delta: 'hm' })).toEqual([]);
    expect(turn.itemCompleted({ ...child, item: { type: 'agentMessage', id: 'm1', text: 'Scripts: test, build.' } })).toEqual([
      { kind: 'text', text: 'Scripts: test, build.', messageId: 'm1', parentToolCallId: 'exec-1' },
    ]);

    // `wait` reports it done: the Agent call settles with its message.
    const wait = { type: 'collabAgentToolCall' as const, id: 'exec-9', tool: 'wait', senderThreadId: 'th', receiverThreadIds: ['child-1'], prompt: null, status: 'completed' as const };
    expect(turn.itemCompleted({ ...at, item: { ...wait, agentsStates: { 'child-1': { status: 'completed', message: 'package.json: scripts test, build.' } } } })).toEqual([
      { kind: 'tool_result', toolCallId: 'exec-1', content: 'package.json: scripts test, build.', isError: false },
    ]);
    // Its turn's end settles nothing twice; the parent's final text is its own.
    expect(turn.subagentTurnCompleted({ threadId: 'child-1', turn: { id: 'ct', status: 'completed' } })).toEqual([]);
    turn.itemCompleted({ ...at, item: { type: 'agentMessage', id: 'a', text: 'Both done.' } });
    turn.complete({ threadId: 'th', turn: { id: 'tu', status: 'completed' } });
    expect(turn.outcome()).toEqual({ kind: 'complete', text: 'Both done.' });
  });

  it('follows multi-agent v2 subagents by their activity, and ends one the turn never heard back from', () => {
    const turn = translator();
    const started = { type: 'subAgentActivity' as const, id: 'call_A', kind: 'started' as const, agentThreadId: 'child-1', agentPath: '/root/say_hello' };
    expect(turn.itemCompleted({ ...at, item: started })).toEqual([
      { kind: 'tool_call', toolCallId: 'call_A', toolName: 'Agent', input: { description: 'say hello', prompt: '', subagent_type: 'say_hello' } },
    ]);
    // Registered once, though Codex sends the item's start and completion.
    expect(turn.itemCompleted({ ...at, item: started })).toEqual([]);
    turn.itemCompleted({ ...child, item: { type: 'agentMessage', id: 'm1', text: 'Hello.' } });
    expect(turn.itemCompleted({ ...at, item: { ...started, id: 'subagent-completed-ct', kind: 'completed' } })).toEqual([
      { kind: 'tool_result', toolCallId: 'call_A', content: 'Hello.', isError: false },
    ]);

    const other = translator();
    other.itemCompleted({ ...at, item: { ...started, agentThreadId: 'child-2' } });
    expect(other.complete({ threadId: 'th', turn: { id: 'tu', status: 'completed' } })).toEqual([
      { kind: 'tool_result', toolCallId: 'call_A', content: 'The subagent was still running when the turn ended.', isError: false },
    ]);
  });

  it("parks a subagent's approval as its call's, and keeps a question card at the top level", () => {
    const turn = translator();
    turn.itemCompleted({ ...at, item: { type: 'subAgentActivity', id: 'call_A', kind: 'started', agentThreadId: 'child-1', agentPath: '/root/writer' } });
    const approval = turn.approval({ kind: 'command', params: { ...child, itemId: 'exec-7', command: 'printf x > f.txt', cwd: '/w' } });
    expect(approval.permission).toEqual({
      toolCallId: 'child-1:exec-7',
      toolName: 'execute_command',
      input: { command: 'printf x > f.txt', cwd: '/w' },
      parentToolCallId: 'call_A',
    });
    expect(approval.entries.map(entry => entry.kind)).toEqual(['tool_call', 'permission']);
    expect(approval.entries.every(entry => 'parentToolCallId' in entry && entry.parentToolCallId === 'call_A')).toBe(true);

    const question = turn.question({ ...child, itemId: 'q1', questions: [{ id: 'a', header: 'A', question: 'Which?' }] });
    expect(question.permission).toEqual({ toolCallId: 'child-1:q1', toolName: 'AskUserQuestion', input: { questions: [{ id: 'a', header: 'A', question: 'Which?' }] } });
  });

  it('records a generated image, and reads a terminal left running as a background shell', () => {
    const turn = translator();
    expect(turn.itemCompleted({ ...at, item: { type: 'imageGeneration', id: 'ig1', status: 'completed', revisedPrompt: 'A red fox', savedPath: '/home/.codex/images/fox.png' } })).toEqual([
      { kind: 'tool_call', toolCallId: 'ig1', toolName: 'generate_image', input: { prompt: 'A red fox' } },
      { kind: 'tool_result', toolCallId: 'ig1', content: 'Saved the image to /home/.codex/images/fox.png.', isError: false },
    ]);
    expect(turn.itemCompleted({ ...at, item: { type: 'imageGeneration', id: 'ig2', status: 'failed', failure: { type: 'usageLimitExceeded' } } }).at(-1)).toEqual({
      kind: 'tool_result',
      toolCallId: 'ig2',
      content: 'Image generation is out of usage for now.',
      isError: true,
    });

    const server = { type: 'commandExecution' as const, id: 'c1', command: 'pnpm dev', cwd: '/w', processId: '41', source: 'unifiedExecStartup' };
    expect(turn.itemCompleted({ ...at, item: { ...server, status: 'inProgress', aggregatedOutput: 'ready on :3000\n' } })).toEqual([
      { kind: 'tool_call', toolCallId: 'c1', toolName: 'execute_command', input: { command: 'pnpm dev', cwd: '/w' } },
      { kind: 'tool_result', toolCallId: 'c1', content: 'ready on :3000\n\nStill running in the background (process 41).', isError: false },
    ]);
    const poll = { type: 'commandExecution' as const, id: 'c2', command: 'pnpm dev', cwd: '/w', processId: '41', source: 'unifiedExecInteraction', status: 'inProgress' as const };
    expect(turn.itemStarted({ ...at, item: poll })).toEqual([
      { kind: 'tool_call', toolCallId: 'c2', toolName: 'get_process_output', input: { pid: '41', command: 'pnpm dev', cwd: '/w' } },
    ]);
  });

  it("shows every file of a change in its approval card, each under its own header, with the line counts", () => {
    const turn = translator();
    turn.itemStarted({
      ...at,
      item: {
        type: 'fileChange',
        id: 'p1',
        status: 'inProgress',
        changes: [
          { path: 'src/a.ts', kind: { type: 'update' }, diff: '@@ -1,2 +1,2 @@\n-const a = 1;\n+const a = 2;\n keep();' },
          { path: 'src/new.ts', kind: { type: 'add' }, diff: 'export const b = 1;\nexport const c = 2;' },
        ],
      },
    });
    const { permission } = turn.approval({ kind: 'fileChange', params: { ...at, itemId: 'p1', reason: 'Bump a' } });
    expect(permission.input).toEqual({
      path: 'src/a.ts',
      paths: ['src/a.ts', 'src/new.ts'],
      diff: '@@ update src/a.ts @@\n@@ -1,2 +1,2 @@\n-const a = 1;\n+const a = 2;\n keep();\n@@ add src/new.ts @@\n+export const b = 1;\n+export const c = 2;',
      added_lines: 3,
      removed_lines: 1,
      reason: 'Bump a\n\nFiles:\nadd src/new.ts\nupdate src/a.ts',
    });
  });
});

describe('codexErrorFromTurn', () => {
  it("classifies Codex's failures as the Factory's error kinds", () => {
    expect(codexErrorFromTurn({ message: 'limit', codexErrorInfo: 'usageLimitExceeded' })).toMatchObject({ kind: 'rate_limit', code: 'usageLimitExceeded' });
    expect(codexErrorFromTurn({ message: 'x', codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 429 } } })).toMatchObject({ kind: 'rate_limit', status: 429 });
    expect(codexErrorFromTurn({ message: 'Please run codex login' })).toMatchObject({ kind: 'auth' });
    expect(codexErrorFromTurn({ message: 'x', codexErrorInfo: 'contextWindowExceeded' })).toMatchObject({ kind: 'context' });
    expect(codexErrorFromTurn({ message: 'x', codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 502 } } })).toMatchObject({ kind: 'overloaded', status: 502 });
    expect(codexErrorFromTurn({ message: 'odd' })).toMatchObject({ kind: 'unknown', message: 'odd' });
  });

  it('draws a command Codex parsed as one read, listing or search as the file tool for it', () => {
    const turn = translator();
    const command = (id: string, commandActions: unknown[]) => ({
      type: 'commandExecution' as const,
      id,
      command: 'x',
      cwd: '/w',
      status: 'inProgress' as const,
      commandActions: commandActions as never,
    });
    expect(turn.itemStarted({ ...at, item: command('c1', [{ type: 'read', command: 'cat a.ts', name: 'a.ts', path: 'src/a.ts' }]) })).toEqual([
      { kind: 'tool_call', toolCallId: 'c1', toolName: 'view', input: { command: 'x', cwd: '/w', path: 'src/a.ts' } },
    ]);
    expect(turn.itemStarted({ ...at, item: command('c2', [{ type: 'search', command: 'rg foo', query: 'foo', path: 'src' }]) })).toEqual([
      { kind: 'tool_call', toolCallId: 'c2', toolName: 'search_content', input: { command: 'x', cwd: '/w', pattern: 'foo', path: 'src' } },
    ]);
    expect(turn.itemStarted({ ...at, item: command('c3', [{ type: 'listFiles', command: 'ls', path: null }]) })).toEqual([
      { kind: 'tool_call', toolCallId: 'c3', toolName: 'list_files', input: { command: 'x', cwd: '/w' } },
    ]);
    // Several actions, or none Codex understood: a command.
    expect(
      turn.itemStarted({
        ...at,
        item: command('c4', [
          { type: 'read', command: 'cat a', name: 'a', path: 'a' },
          { type: 'unknown', command: 'make' },
        ]),
      }),
    ).toEqual([{ kind: 'tool_call', toolCallId: 'c4', toolName: 'execute_command', input: { command: 'x', cwd: '/w' } }]);
  });
});
