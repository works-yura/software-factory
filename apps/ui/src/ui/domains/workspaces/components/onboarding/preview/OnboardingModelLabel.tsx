import { Txt } from '@mastra/playground-ui/components/Txt';
import { useTranslation } from 'react-i18next';
import { OnboardingSuggestedModelLabel } from './OnboardingSuggestedModelLabel';

export function OnboardingModelLabel({
  providerId,
  model,
  scope,
}: {
  providerId?: string;
  model?: string;
  scope: 'org' | 'user';
}) {
  const { t } = useTranslation('workspaces');
  if (!model && providerId) return <OnboardingSuggestedModelLabel providerId={providerId} scope={scope} />;
  return (
    <Txt variant="meta" tone="muted" className="truncate">
      {model ?? t('review.chooseModel')}
    </Txt>
  );
}
