import { Txt } from '@mastra/playground-ui/components/Txt';
import { useTranslation } from 'react-i18next';

import { useModelCatalogQuery } from '../../../../../../hooks/useAvailableModels';
import { instanceForHarness, toProviderInstances } from '../../../../chat/components/modelPicker/providerInstances';
import { modelLabel } from './modelDefaultView';

/**
 * A harness's default model, read-only, where a screen routes through it (the routing map's
 * Factory defaults card); it is set in Default models above.
 */
export function DefaultModelSummary({ factoryId, harnessId }: { factoryId: string; harnessId: string }) {
  const { t } = useTranslation('settings');
  const catalogQuery = useModelCatalogQuery({ factoryProjectId: factoryId });
  const entry = instanceForHarness(toProviderInstances(catalogQuery.data), harnessId);
  const name = entry ? modelLabel(entry, entry.factoryDefault ?? entry.catalogDefault) : null;
  return (
    <div className="flex min-h-control-sm min-w-0 flex-wrap items-center gap-x-2">
      <Txt as="span" variant="caption" className="truncate">
        {name ?? t('models.defaults.followsHarness')}
      </Txt>
      <a href="#model-defaults" className="text-caption text-muted-foreground hover:text-foreground underline-offset-2 hover:underline">
        {t('models.defaults.change')}
      </a>
    </div>
  );
}
