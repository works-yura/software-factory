import { Badge } from '@mastra/playground-ui/components/Badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@mastra/playground-ui/components/Tooltip';
import { focusRing } from '@mastra/playground-ui/primitives/transitions';

import type { InstalledPhaseInfo } from '../../../../api/types';
import { translator } from '../../../i18n/t';

const tk = translator('board');

export type PhaseExitToolInfo = InstalledPhaseInfo['exitTool'];

/** "Planning ends when submit_plan succeeds. A person approves it." */
function phaseExitToolDescription(phaseLabel: string, exitTool: NonNullable<PhaseExitToolInfo>): string {
  const approval = !exitTool.autoApprove
    ? tk('exitTool.personApproves')
    : exitTool.autoApproveWhen
      ? tk('exitTool.autoApprovesMatching')
      : tk('exitTool.autoApproves');
  return tk('exitTool.description', { phase: phaseLabel, tool: exitTool.id, approval });
}

/** The tool whose success ends a working phase, and who approves it. */
export function PhaseExitTool({
  phaseLabel,
  exitTool,
}: {
  phaseLabel: string;
  exitTool: NonNullable<PhaseExitToolInfo>;
}) {
  const description = phaseExitToolDescription(phaseLabel, exitTool);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            tabIndex={0}
            aria-label={description}
            className={`inline-flex min-w-0 rounded-sm ${focusRing}`}
          >
            <Badge size="xs" variant="neutral" className="min-w-0 font-mono">
              <span className="truncate">{exitTool.id}</span>
            </Badge>
          </span>
        }
      />
      <TooltipContent side="bottom" className="max-w-72">
        {description}
      </TooltipContent>
    </Tooltip>
  );
}
