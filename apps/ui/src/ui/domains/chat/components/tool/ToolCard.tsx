import {
  Activity,
  ActivityContent,
  ActivityHeadline,
  ActivityTrigger,
} from '@mastra/playground-ui/components/ai/activity';
import { displayToolName, presentTool, ToolCallExitStatus } from '@mastra/playground-ui/components/ai/tool-call';

import { translator } from '../../../../i18n/t';
import { toolCallStatus } from '../../services/transcript';
import type { ToolCall } from '../../services/transcript';
import { ToolBody, toolHasBody } from './ToolBody';

const tk = translator('chat');

export function ToolCard({
  tool,
  open,
  onOpenChange,
}: {
  tool: ToolCall;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const { icon: ToolIcon, label, detail, description, command } = presentTool(tool.toolName, tool.args);
  const foldable = toolHasBody(tool, command);

  return (
    <Activity
      appearance="inline"
      foldable={foldable}
      status={toolCallStatus(tool.status)}
      aria-label={tk('messages.tool', { name: displayToolName(tool.toolName) })}
      aria-busy={tool.status === 'running'}
      open={open && foldable}
      onOpenChange={onOpenChange}
    >
      <div className="flex w-full min-w-0 items-center">
        <ActivityTrigger className="min-w-0 flex-1">
          <ActivityHeadline icon={<ToolIcon aria-hidden />} label={label} detail={detail} description={description} />
        </ActivityTrigger>
        {tool.exit && <ToolCallExitStatus exit={tool.exit} />}
      </div>
      <ActivityContent>
        <ToolBody tool={tool} command={command} />
      </ActivityContent>
    </Activity>
  );
}
