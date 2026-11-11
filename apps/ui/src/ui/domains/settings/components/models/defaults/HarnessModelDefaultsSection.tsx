// Settings → Models → Default model of the harness this Factory runs on (chosen above it). Every
// harness renders through the same component (`HarnessModelDefaults`); the other harnesses keep
// their saved defaults and show them once the Factory switches to them.
import { Txt } from '@mastra/playground-ui/components/Txt';
import { useTranslation } from 'react-i18next';

import { useModelCatalogQuery } from '../../../../../../hooks/useAvailableModels';
import { useFactoryProjectQuery } from '../../../../../../hooks/useFactoryDefaultModel';
import { SkeletonRows } from '../../../../../ui/SkeletonRows';
import { toProviderInstances } from '../../../../chat/components/modelPicker/providerInstances';
import { SettingsSubsection } from '../../SettingsSubsection';
import { HarnessModelDefaults } from './HarnessModelDefaults';

export function HarnessModelDefaultsSection({ factoryId }: { factoryId: string }) {
  const { t } = useTranslation('settings');
  const catalogQuery = useModelCatalogQuery({ factoryProjectId: factoryId });
  const projectQuery = useFactoryProjectQuery(factoryId);
  const harness = projectQuery.data?.harness ?? 'mastra';
  const entry = toProviderInstances(catalogQuery.data).find(instance => instance.driverKind === harness);

  return (
    <SettingsSubsection
      id="model-defaults"
      scope="factory"
      title={t('models.defaults.title')}
      description={t('models.defaults.description')}
    >
      {catalogQuery.isPending ? (
        <SkeletonRows label={t('models.defaults.title')} rows={2} />
      ) : catalogQuery.isError ? (
        <Txt as="p" variant="caption" className="text-destructive-foreground" role="alert">
          {t('models.defaults.loadFailed')}
        </Txt>
      ) : entry ? (
        <HarnessModelDefaults key={entry.instanceId} factoryId={factoryId} entry={entry} />
      ) : projectQuery.isSuccess ? (
        <Txt as="p" variant="caption" tone="muted" role="status">
          {t('models.defaults.harnessUnavailable')}
        </Txt>
      ) : (
        <SkeletonRows label={t('models.defaults.title')} rows={2} />
      )}
    </SettingsSubsection>
  );
}
