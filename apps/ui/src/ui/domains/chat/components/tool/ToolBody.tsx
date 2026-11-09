import { ToolCallBody, toolCallHasBody } from '@mastra/playground-ui/components/ai/tool-call';
import type { ToolCallView } from '@mastra/playground-ui/components/ai/tool-call';

import { toolCallStatus } from '../../services/transcript';
import type { ToolCall } from '../../services/transcript';

function toolCallView(tool: ToolCall, command: string | undefined): ToolCallView {
  return {
    toolName: tool.toolName,
    args: tool.args,
    argsText: tool.argsText,
    status: toolCallStatus(tool.status),
    command,
    output: tool.output,
    result: tool.result,
    exit: tool.exit,
  };
}

export function toolHasBody(tool: ToolCall, command: string | undefined): boolean {
  return toolCallHasBody(toolCallView(tool, command));
}

export function ToolBody({ tool, command }: { tool: ToolCall; command?: string }) {
  return <ToolCallBody {...toolCallView(tool, command)} />;
}
