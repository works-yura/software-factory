import { Field, FieldContent, FieldDescription, FieldLabel } from '@mastra/playground-ui/components/Field';
import { Popover, PopoverContent, PopoverTrigger } from '@mastra/playground-ui/components/Popover';
import { Switch } from '@mastra/playground-ui/components/Switch';
import { toast } from '@mastra/playground-ui/components/Toaster';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { Settings2 } from 'lucide-react';
import type { UseMutationResult } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

import { useSetFactoryAutomationMutation } from '../../../../hooks/useFactoryAutomation';

function AutomationSwitch({
  label,
  description,
  enabled,
  mutation,
}: {
  label: string;
  description: string;
  enabled: boolean;
  mutation: UseMutationResult<unknown, Error, boolean>;
}) {
  return (
    <Field orientation="horizontal" className="items-start gap-4">
      <FieldContent>
        <FieldLabel>{label}</FieldLabel>
        <FieldDescription>{description}</FieldDescription>
      </FieldContent>
      <Switch
        aria-label={label}
        checked={enabled}
        disabled={mutation.isPending}
        onCheckedChange={next => mutation.mutate(next, { onError: error => toast.error(error.message) })}
      />
    </Field>
  );
}

export function BoardAutomationSettings({
  factoryProjectId,
  autoRunEnabled,
  selfReviewEnabled,
  offersSelfReview,
}: {
  factoryProjectId: string;
  autoRunEnabled: boolean;
  selfReviewEnabled: boolean;
  /** Whether this board has a self-review phase for the setting to turn on. */
  offersSelfReview: boolean;
}) {
  const { t } = useTranslation('board');
  const autoRun = useSetFactoryAutomationMutation(factoryProjectId, 'autoRunEnabled');
  const selfReview = useSetFactoryAutomationMutation(factoryProjectId, 'selfReviewEnabled');

  return (
    <Popover>
      <PopoverTrigger variant="default" size="icon-sm" aria-label={t('automationSettings.title')}
        tooltip={t('automationSettings.title')}
      >
        <Settings2 aria-hidden />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 max-w-[calc(100vw-2rem)]" aria-label={t('automationSettings.title')}
      >
        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-1">
            <Txt as="h2" variant="subheading">
              {t('automationSettings.heading')}
            </Txt>
            <Txt variant="caption" tone="muted">
              {t('automationSettings.scope')}
            </Txt>
          </div>
          <AutomationSwitch
            label={t('automationSettings.autoRun.label')}
            enabled={autoRunEnabled}
            mutation={autoRun}
            description={t('automationSettings.autoRun.description')}
          />
          {offersSelfReview && (
            <AutomationSwitch
              label={t('automationSettings.selfReview.label')}
              enabled={selfReviewEnabled}
              mutation={selfReview}
              description={t('automationSettings.selfReview.description')}
            />
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
