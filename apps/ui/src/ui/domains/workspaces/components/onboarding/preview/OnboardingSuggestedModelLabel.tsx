import { Txt } from '@mastra/playground-ui/components/Txt';
import { useTranslation } from 'react-i18next';
import { useProviderModels } from '../../../hooks/useProviderModels';

export function OnboardingSuggestedModelLabel({ providerId }: { providerId: string }) {
  const { t } = useTranslation('workspaces');
  const catalog = useProviderModels(providerId);
  return (
    <Txt variant="meta" tone="muted" className="truncate">
      {catalog.suggestedModelId ?? t('review.chooseModel')}
    </Txt>
  );
}
