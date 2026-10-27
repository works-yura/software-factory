import { toast } from '@mastra/playground-ui/components/Toaster';
import { useTranslation } from 'react-i18next';

import { useFactoryAuth } from '../../../../hooks/useFactoryAuth';
import { useSessionVisibility } from '../hooks/useSessionVisibility';
import type { FactoryUserSession } from '../services/user-sessions';
import { SLACK_SESSION_BRANCH_PREFIX } from '../services/user-sessions';
import { SessionSharingPopover } from './SessionSharingPopover';

export function UserSessionSharing({ factoryId, session }: { factoryId: string; session: FactoryUserSession }) {
  const { t } = useTranslation('workspaces');
  const viewerUserId = useFactoryAuth().data?.user?.userId;
  const { changeVisibility, changing } = useSessionVisibility(factoryId, session.sessionId);
  const canShare = viewerUserId === session.userId && !session.branch.startsWith(SLACK_SESSION_BRANCH_PREFIX);

  if (session.visibility !== 'private') return null;

  async function handleShare() {
    try {
      await changeVisibility('org');
      toast(t('sharing.sharedToast'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('sharing.changeFailed'));
    }
  }

  return (
    <SessionSharingPopover
      name={session.title ?? t('sessions.newSession')}
      placement="header"
      onShare={canShare ? handleShare : undefined}
      sharing={changing}
    />
  );
}
