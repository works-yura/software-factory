import { Badge } from '@mastra/playground-ui/components/Badge';
import { SegmentedControl, SegmentedControlItem } from '@mastra/playground-ui/components/SegmentedControl';
import { useTranslation } from 'react-i18next';

import { SANDBOX_STAGES } from '../../../workspaces/services/sandbox-envs';
import type { SandboxStage } from '../../../workspaces/services/sandbox-envs';

const STAGE_VARIANT = { development: 'success', staging: 'warning', production: 'destructive' } as const;

/** The stage a variable or env file belongs to. */
export function StageBadge({ stage }: { stage: SandboxStage }) {
  const { t } = useTranslation('settings');
  return (
    <Badge size="sm" variant={STAGE_VARIANT[stage]}>
      {t(`sandboxStages.stage.${stage}`)}
    </Badge>
  );
}

/** Pick one stage; production is offered but says it never reaches agent sandboxes. */
export function StagePicker({
  value,
  onChange,
  label,
  disabled,
}: {
  value: SandboxStage;
  onChange: (stage: SandboxStage) => void;
  label: string;
  disabled?: boolean;
}) {
  const { t } = useTranslation('settings');
  return (
    <SegmentedControl
      aria-label={label}
      value={value}
      disabled={disabled}
      onValueChange={next => onChange(next as SandboxStage)}
    >
      {SANDBOX_STAGES.map(stage => (
        <SegmentedControlItem key={stage} value={stage}>
          {t(`sandboxStages.stage.${stage}`)}
        </SegmentedControlItem>
      ))}
    </SegmentedControl>
  );
}
