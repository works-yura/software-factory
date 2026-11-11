import { describe, expect, it } from 'vitest';

import {
  displayToolName,
  hasToolArguments,
  isTaskTool,
  presentedToolCall,
  presentTool,
  stringifyToolValue,
  toolEdit,
} from './tool-presentation';

describe('presentTool', () => {
  it('maps stable workspace aliases to humanized actions with their salient argument', () => {
    expect(presentTool('view', { path: 'src/a.ts' })).toMatchObject({ label: 'Read', detail: 'src/a.ts' });
    expect(presentTool('search_content', { pattern: 'useChat' })).toMatchObject({ label: 'Search', detail: 'useChat' });
    expect(presentTool('string_replace', { path: 'src/a.ts' })).toMatchObject({ label: 'Edit', detail: 'src/a.ts' });
  });

  it('marks terminal-style tools with their command for the expanded body', () => {
    expect(presentTool('execute_command', { command: 'pnpm test' })).toMatchObject({
      label: 'Run',
      detail: 'pnpm test',
      command: 'pnpm test',
    });
  });

  it('keeps the cd preamble out of the row but inside the command', () => {
    const cd = "cd '/Users/me/work spaces/repo' && pnpm build";
    expect(presentTool('execute_command', { command: cd })).toMatchObject({ detail: 'pnpm build', command: cd });
  });

  it('strips an unquoted cd preamble too', () => {
    const cd = 'cd packages/core && pnpm build';
    expect(presentTool('execute_command', { command: cd })).toMatchObject({ detail: 'pnpm build', command: cd });
  });

  it('leaves a bare cd alone — it is the whole command', () => {
    expect(presentTool('execute_command', { command: 'cd packages/core' })).toMatchObject({
      detail: 'cd packages/core',
    });
  });

  it("adds a command's description, keeping the label, detail, and command for consumers that pick fields", () => {
    const command = "cd packages/core && rg -n 'processor' src | head -20";
    const presentation = presentTool('execute_command', { description: 'Finding  the processor\n wiring', command });
    expect(presentation).toMatchObject({
      label: 'Run',
      detail: "rg -n 'processor' src | head -20",
      description: 'Finding the processor wiring',
      command,
    });
  });

  it('falls back to the command when the description is blank', () => {
    const presentation = presentTool('execute_command', { description: '  ', command: 'git status' });
    expect(presentation).toMatchObject({ label: 'Run', detail: 'git status', command: 'git status' });
    expect(presentation.description).toBeUndefined();
  });

  it('strips the raw workspace prefix before lookup', () => {
    expect(presentTool('mastra_workspace_read_file', { path: 'a.ts' })).toMatchObject({
      label: 'Read',
      detail: 'a.ts',
    });
  });

  it('turns the agent indicator into the work each call does, and a tool it does not know into a nut', () => {
    expect(presentTool('execute_command', { command: 'ls' }).pose).toBe('running');
    expect(presentTool('view', { path: 'a.ts' }).pose).toBe('reading');
    expect(presentTool('mastra_workspace_grep', { pattern: 'x' }).pose).toBe('searching');
    expect(presentTool('web_search', { query: 'oauth' }).pose).toBe('browsing');
    expect(presentTool('fetch_pull_request', undefined).pose).toBe('tool');
  });

  it('prettifies unknown tool names instead of surfacing raw identifiers', () => {
    expect(presentTool('fetch_pull_request', undefined).label).toBe('Fetch pull request');
  });

  it('omits the detail when the salient argument has not streamed yet', () => {
    expect(presentTool('execute_command', undefined).detail).toBeUndefined();
  });
});

describe('Claude Code tools', () => {
  it.each([
    ['Bash', { command: 'git status', description: 'Show status' }, 'execute_command', { command: 'git status' }],
    ['Read', { file_path: 'src/a.ts', offset: 10 }, 'view', { path: 'src/a.ts' }],
    ['Edit', { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' }, 'string_replace_lsp', { path: 'src/a.ts' }],
    ['MultiEdit', { file_path: 'src/a.ts', edits: [] }, 'string_replace_lsp', { path: 'src/a.ts' }],
    ['NotebookEdit', { notebook_path: 'n.ipynb', new_source: 'x' }, 'string_replace_lsp', { path: 'n.ipynb' }],
    ['Write', { file_path: 'src/a.ts', content: 'x' }, 'write_file', { path: 'src/a.ts' }],
    ['Grep', { pattern: 'useChat', path: 'src', glob: '*.ts' }, 'search_content', { pattern: 'useChat' }],
    ['Glob', { pattern: '**/*.ts', path: 'src' }, 'find_files', { pattern: '**/*.ts' }],
    ['LS', { path: 'src' }, 'list_files', { path: 'src' }],
    ['WebFetch', { url: 'https://example.com', prompt: 'Summarize' }, 'web_fetch', { url: 'https://example.com' }],
    ['WebSearch', { query: 'vitest projects' }, 'web_search', { query: 'vitest projects' }],
    ['Skill', { skill: 'triage-issue' }, 'skill', { name: 'triage-issue' }],
  ])('presents %s exactly as its Mastra twin', (claudeName, claudeArgs, mastraName, mastraArgs) => {
    expect(presentedToolCall(claudeName, claudeArgs)).toMatchObject({ toolName: mastraName, args: mastraArgs });
    const { icon, label, detail } = presentTool(mastraName, mastraArgs);
    expect(presentTool(claudeName, claudeArgs)).toMatchObject({ icon, label, detail });
  });

  it('shows a Bash command, its description and the command body like execute_command', () => {
    const command = 'cd packages/core && pnpm build';
    expect(presentTool('Bash', { command, description: 'Build core', run_in_background: false })).toEqual({
      pose: 'running',
      icon: presentTool('execute_command', { command }).icon,
      label: 'Run',
      kind: 'Run',
      detail: 'pnpm build',
      description: 'Build core',
      command,
    });
  });

  it('reads an Edit, a MultiEdit and a Write as file changes', () => {
    expect(toolEdit('Edit', { file_path: 'a.ts', old_string: 'x', new_string: 'y', replace_all: true })).toEqual({
      path: 'a.ts',
      oldText: 'x',
      newText: 'y',
    });
    expect(
      toolEdit('MultiEdit', {
        file_path: 'a.ts',
        edits: [
          { old_string: 'a', new_string: 'b' },
          { old_string: 'c', new_string: 'd' },
        ],
      }),
    ).toEqual({ path: 'a.ts', oldText: 'a\nc', newText: 'b\nd' });
    expect(toolEdit('Write', { file_path: 'a.ts', content: 'x' })).toEqual({ path: 'a.ts', content: 'x' });
    expect(toolEdit('Read', { file_path: 'a.ts' })).toBeUndefined();
  });

  it('reads a Codex file change with a unified diff as an edit', () => {
    expect(toolEdit('string_replace_lsp', { path: 'a.ts', diff: '@@ -1 +1 @@\n-x\n+y' })).toEqual({ path: 'a.ts', diff: '@@ -1 +1 @@\n-x\n+y' });
    expect(toolEdit('string_replace_lsp', { path: 'a.ts', diff: '' })).toBeUndefined();
    expect(toolEdit('write_file', { path: 'a.ts', content: 'x' })).toEqual({ path: 'a.ts', content: 'x' });
  });

  it('presents a call whose arguments have not streamed yet without a detail', () => {
    const presentation = presentTool('Read', undefined);
    expect(presentation.label).toBe('Read');
    expect(presentation.detail).toBeUndefined();
  });

  it('presents a Factory MCP tool as the bare tool Mastra runs call', () => {
    expect(presentedToolCall('mcp__factory__skill', { name: 'x' })).toEqual({ toolName: 'skill', args: { name: 'x' } });
    expect(presentTool('mcp__factory__source_control_push', {})).toMatchObject({ label: 'Source control push' });
    expect(displayToolName('mcp__factory__source_control_push')).toBe('source_control_push');
  });

  it('keeps the server of a foreign MCP tool, and never borrows a workspace style for it', () => {
    expect(presentTool('mcp__github__search', { query: 'bug' })).toEqual({
      pose: 'tool',
      icon: presentTool('unknown_tool', {}).icon,
      label: 'github · Search',
    });
    expect(displayToolName('mcp__github__create_issue')).toBe('github · create_issue');
  });

  it('leaves unknown tools to the generic rendering', () => {
    expect(presentedToolCall('TodoWrite', { todos: [] })).toEqual({ toolName: 'TodoWrite', args: { todos: [] } });
    expect(presentTool('TodoWrite', { todos: [] })).toMatchObject({ label: 'TodoWrite' });
    expect(displayToolName('TodoWrite')).toBe('TodoWrite');
  });
});

describe('stringifyToolValue', () => {
  it('passes strings through and pretty-prints the rest', () => {
    expect(stringifyToolValue('already text')).toBe('already text');
    expect(stringifyToolValue({ path: 'a.ts' })).toBe('{\n  "path": "a.ts"\n}');
  });

  it('falls back to String for values JSON cannot carry', () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(stringifyToolValue(cyclic)).toBe('[object Object]');
    expect(stringifyToolValue(undefined)).toBe('undefined');
  });
});

describe('toolEdit', () => {
  it('reads a replacement as the two sides of a diff, an empty new side included', () => {
    expect(toolEdit('mastra_workspace_edit_file', { path: 'a.ts', old_string: 'x', new_string: '' })).toEqual({
      path: 'a.ts',
      oldText: 'x',
      newText: '',
    });
  });

  it('reads a written file as its content', () => {
    expect(toolEdit('write_file', { path: 'a.ts', content: 'x' })).toEqual({ path: 'a.ts', content: 'x' });
  });

  it('leaves other calls to the raw arguments', () => {
    expect(toolEdit('view', { path: 'a.ts' })).toBeUndefined();
    expect(toolEdit('edit_file', { path: 'a.ts' })).toBeUndefined();
  });
});

describe('isTaskTool', () => {
  it('names the four task tools the docked task list draws, and nothing else', () => {
    expect(['task_write', 'task_update', 'task_complete', 'task_check'].every(isTaskTool)).toBe(true);
    expect(['view', 'task', 'ask_user'].some(isTaskTool)).toBe(false);
  });
});

describe('hasToolArguments', () => {
  it('has nothing to show before any input arrives', () => {
    expect(hasToolArguments({ toolName: 'view', args: undefined, argsText: '' })).toBe(false);
  });

  it('has nothing to show for a tool called without arguments', () => {
    expect(hasToolArguments({ toolName: 'list_agents', args: {}, argsText: '{}' })).toBe(false);
  });

  it('shows partial streamed input before it parses', () => {
    expect(hasToolArguments({ toolName: 'view', args: undefined, argsText: '{"path":"src' })).toBe(true);
  });

  it('shows an edit even when ordinary arguments are hidden', () => {
    const args = { path: 'a.ts', old_string: 'a', new_string: 'b' };
    expect(hasToolArguments({ toolName: 'edit_file', args, hideArguments: true })).toBe(true);
    expect(hasToolArguments({ toolName: 'view', args: { path: 'a.ts' }, hideArguments: true })).toBe(false);
  });
});
