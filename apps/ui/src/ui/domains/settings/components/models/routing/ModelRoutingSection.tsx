import { useTranslation } from 'react-i18next';

import { SettingsSubsection } from '../../SettingsSubsection';
import { ModelRoutingMap } from './ModelRoutingMap';

/** Where Mastra's chats and card runs get their models: the Factory defaults and its providers. */
export function ModelRoutingSection({ factoryId }: { factoryId: string }) {
  const { t } = useTranslation('settings');
  return (
    <SettingsSubsection scope="factory" title={t('routing.title')} description={t('routing.description')}>
      <ModelRoutingMap factoryId={factoryId} />
    </SettingsSubsection>
  );
}
