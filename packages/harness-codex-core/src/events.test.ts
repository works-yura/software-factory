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
      { kind: 'tool_call', toolCallId: 'p1:1', toolName: 'string_replace_lsp', input: { path: 'src/a.ts', diff: '-a\n+b' } },
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
