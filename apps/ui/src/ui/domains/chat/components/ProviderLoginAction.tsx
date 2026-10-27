import { Notice } from '@mastra/playground-ui/components/Notice';
import { ArrowRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation } from 'react-router';

import { MODEL_DEFAULTS_ANCHORS, settingsSectionPath } from '../../settings/settingsSections';
import { useChatModelCatalog } from '../context/useChatModelCatalog';

/** Sends the user to the Factory defaults on the Models page, which own the credentials every session runs on. */
export function ProviderLoginAction() {
  const { t } = useTranslation('chat');
  const location = useLocation();
  const { factoryId } = useChatModelCatalog();
  if (!factoryId) return null;

  return (
    <Notice.Button
      render={
        <Link
          to={settingsSectionPath(factoryId, 'models', MODEL_DEFAULTS_ANCHORS.factory)}
          state={{ from: location }}
        />
      }
    >
      {t('messages.login')} <ArrowRight aria-hidden="true" />
    </Notice.Button>
  );
}
