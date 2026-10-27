import { Notice } from '@mastra/playground-ui/components/Notice';
import { useTranslation } from 'react-i18next';
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

  // The catalog marks the in-sentence link as <link>…</link>, so each language places it where its grammar needs.
  const [before = '', linkText = '', after = ''] = t('models.scopeNotice.body').split(/<\/?link>/);

  return (
    <div role="note">
      <Notice variant="info" title={t('models.scopeNotice.title')}>
        {before}
        <Link to={settingsSectionPath(factoryId, 'models')} className="underline">
          {linkText}
        </Link>
        {after}
      </Notice>
    </div>
  );
}
