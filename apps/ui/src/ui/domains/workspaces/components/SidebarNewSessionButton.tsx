import { Button } from '@mastra/playground-ui/components/Button';
import { Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router';

import { useFactoryQuery } from '../../../../hooks/useFactories';
import { useOpenNewUserSession } from '../hooks/useOpenNewUserSession';

/** The "+" beside the Sessions header: starts a new session in this Factory. */
export function SidebarNewSessionButton() {
  const { factoryId } = useParams<{ factoryId: string }>();
  const factory = useFactoryQuery(factoryId);
  const openNewUserSession = useOpenNewUserSession();
  const { t } = useTranslation('nav');

  const hasRepositories = (factory.data?.repositories.length ?? 0) > 0;
  if (!factoryId || !hasRepositories) return null;

  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={t('newSession')}
      tooltip={t('newSession')}
      onClick={() => openNewUserSession(factoryId)}
    >
      <Plus aria-hidden />
    </Button>
  );
}
