import { Notice } from '@mastra/playground-ui/components/Notice';
import { Trans, useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';

import { useFactoryAuth } from '../../../../hooks/useFactoryAuth';
import { useFactoryProjectQuery } from '../../../../hooks/useFactoryDefaultModel';
import { settingsSectionPath } from '../settingsSections';

/**
 * Personal credentials are invisible to an organization-scoped Factory (the
 * scopes are exclusive), so a "Signed in" provider here can still fail every
 * run. Say so on the page where users go to fix credentials.
 */
export function FactoryModelScopeNotice() {
  const { factoryId } = useParams<{ factoryId: string }>();
  const authQuery = useFactoryAuth();
  const projectQuery = useFactoryProjectQuery(factoryId);
  const { t } = useTranslation('settings');

  if (!factoryId || authQuery.data?.authEnabled !== true) return null;
  if ((projectQuery.data?.modelScope ?? 'user') !== 'factory') return null;

  return (
    <div role="note">
      <Notice variant="info" title={t('models.scopeNotice.title')}>
        <Trans
          t={t}
          i18nKey="models.scopeNotice.body"
          components={{ link: <Link to={settingsSectionPath(factoryId, 'models')} className="underline" /> }}
        />
      </Notice>
    </div>
  );
}
