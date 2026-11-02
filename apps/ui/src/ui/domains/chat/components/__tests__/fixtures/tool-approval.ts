import type { ApprovalPrompt } from '../../../services/transcript';

export const toolApproval: ApprovalPrompt = {
  kind: 'approval',
  id: 'approval-1',
  toolCallId: 'call-1',
  toolName: 'write_file',
  args: { path: 'src/agent.ts' },
};

/** A Claude Code permission request: the CLI's tool name and argument shape. */
export const claudeEditApproval: ApprovalPrompt = {
  kind: 'approval',
  id: 'approval-edit',
  toolCallId: 'call-edit',
  toolName: 'Edit',
  args: { file_path: 'src/agent.ts', old_string: 'const a = 1', new_string: 'const a = 2' },
};

export const claudeFactoryMcpApproval: ApprovalPrompt = {
  kind: 'approval',
  id: 'approval-mcp',
  toolCallId: 'call-mcp',
  toolName: 'mcp__factory__source_control_push',
  args: { branch: 'feat/x' },
};
