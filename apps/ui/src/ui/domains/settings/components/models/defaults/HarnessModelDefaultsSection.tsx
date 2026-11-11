// Settings → Models → Default models: one row group per harness instance the server runs, the
// same component for each (`HarnessModelDefaults`), in the order the server lists them with the
// harness this Factory starts new sessions on first.
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
  const entries = toProviderInstances(catalogQuery.data);
  const ordered = [
    ...entries.filter(entry => entry.driverKind === harness),
    ...entries.filter(entry => entry.driverKind !== harness),
  ];

  return (
    <SettingsSubsection
      id="model-defaults"
      scope="factory"
      title={t('models.defaults.title')}
      description={t('models.defaults.description')}
    >
      {catalogQuery.isPending ? (
        <SkeletonRows label={t('models.defaults.title')} rows={3} />
      ) : catalogQuery.isError ? (
        <Txt as="p" variant="caption" className="text-destructive-foreground" role="alert">
          {t('models.defaults.loadFailed')}
        </Txt>
      ) : (
        <div className="flex flex-col gap-4">
          {ordered.map(entry => (
            <HarnessModelDefaults
              key={entry.instanceId}
              factoryId={factoryId}
              entry={entry}
              inUse={projectQuery.isSuccess && entry.driverKind === harness}
            />
          ))}
        </div>
      )}
    </SettingsSubsection>
  );
}
