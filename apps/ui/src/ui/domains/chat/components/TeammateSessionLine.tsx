import { Avatar } from '@mastra/playground-ui/components/Avatar';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router';

import { useFactoryAuth } from '../../../../hooks/useFactoryAuth';
import { useUserSessionQuery } from '../../../../hooks/useWorkspaces';
import { isFactoryOwnedSession } from '../../workspaces/services/sessionPresentation';

export function TeammateSessionLine() {
  const { t } = useTranslation('chat');
  const { sessionId, threadId } = useParams<{ sessionId?: string; threadId?: string }>();
  const session = useUserSessionQuery(sessionId ?? threadId).data;
  const viewerUserId = useFactoryAuth().data?.user?.userId;
  if (!session || !viewerUserId || session.userId === viewerUserId) return null;

  const owner = session.owner;
  return (
    <div className="flex min-w-0 items-center gap-2 px-3">
      {owner && (
        <div aria-hidden="true">
          <Avatar name={owner.name} src={owner.avatarUrl} size="xs" />
        </div>
      )}
      <Txt as="p" variant="caption" tone="muted" className="truncate">
        {isFactoryOwnedSession(session)
          ? t('session.factoryOwned')
          : owner
            ? t('session.teammateNamed', { name: owner.name })
            : t('session.teammate')}
      </Txt>
    </div>
  );
}
