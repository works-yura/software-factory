import type { ToolCall } from '../../../services/transcript';

export const commandTool: ToolCall = {
  toolCallId: 'command',
  toolName: 'execute_command',
  args: { command: 'pnpm test' },
  argsText: '',
  status: 'running',
  output: 'Live shell output',
  result: 'Partial structured output',
};

export const editTool: ToolCall = {
  toolCallId: 'edit',
  toolName: 'edit_file',
  args: { path: 'file.ts', old_string: 'before', new_string: 'after' },
  argsText: '',
  status: 'done',
  output: '',
  result: 'File updated',
};

/** Claude Code's own tool names and argument shapes, as a projected Claude session carries them. */
export const claudeBashTool: ToolCall = {
  toolCallId: 'claude-bash',
  toolName: 'Bash',
  args: { command: 'pnpm test --filter ui', timeout: 120000 },
  argsText: '',
  status: 'done',
  output: '',
  result: 'All tests passed',
};

export const claudeEditTool: ToolCall = {
  toolCallId: 'claude-edit',
  toolName: 'Edit',
  args: { file_path: 'src/file.ts', old_string: 'before', new_string: 'after', replace_all: false },
  argsText: '',
  status: 'done',
  output: '',
  result: 'The file src/file.ts has been updated.',
};

export const claudeFactoryMcpTool: ToolCall = {
  toolCallId: 'claude-mcp',
  toolName: 'mcp__factory__source_control_push',
  args: { branch: 'feat/x' },
  argsText: '',
  status: 'done',
  output: '',
  result: 'Pushed',
};

export const longResultTool: ToolCall = {
  toolCallId: 'read',
  toolName: 'view',
  argsText: '',
  status: 'done',
  output: '',
  result: 'File contents\n'.repeat(100),
};
