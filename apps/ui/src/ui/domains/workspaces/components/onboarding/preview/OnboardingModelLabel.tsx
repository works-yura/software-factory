import { Txt } from '@mastra/playground-ui/components/Txt';
import { useTranslation } from 'react-i18next';
import { OnboardingSuggestedModelLabel } from './OnboardingSuggestedModelLabel';

export function OnboardingModelLabel({
  providerId,
  model,
}: {
  providerId?: string;
  model?: string;
}) {
  const { t } = useTranslation('workspaces');
  if (!model && providerId) return <OnboardingSuggestedModelLabel providerId={providerId} />;
  return (
    <Txt variant="meta" tone="muted" className="truncate">
      {model ?? t('review.chooseModel')}
    </Txt>
  );
}
