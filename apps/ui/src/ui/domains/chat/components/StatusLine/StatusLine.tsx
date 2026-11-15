import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router';

import { useFactoryQuery } from '../../../../../hooks/useFactories';
import { useSessionWorkItemsQuery } from '../../../../../hooks/useWorkItems';
import { isPullRequestSource } from '../../../factory/services/workItems';
import { useChatSessionContext } from '../../context/useChatSessionContext';
import { PullRequestLinks } from '../PullRequestLinks';
import { ModelPicker } from './ModelPicker';
import { ConnectionActivity } from './ConnectionActivity';
import { GoalStatus } from './GoalStatus';
import { OperationalMemoryStatus } from './OperationalMemoryStatus';
import { ModelCredential } from './ModelCredential';
import { QueuedFollowUps } from './QueuedFollowUps';
import { RuntimeActivity } from './RuntimeActivity';
import { SessionUsageStatus } from '../../../usage/components/SessionUsageStatus';
import { UsageLimitsStatus } from '../../../usage/components/UsageLimitsStatus';

/**
 * Session status strip below the composer. Pure composition root: each child
 * reads its own slice of the existing chat/session context.
 */
export function StatusLine() {
  const { t } = useTranslation('chat');
  const { factoryId, sessionId, threadId } = useParams<{ factoryId: string; sessionId: string; threadId: string }>();
  const { factorySessionState } = useChatSessionContext();
  const { data: factory } = useFactoryQuery(factoryId);
  const repository = factory?.repositories.find(
    repo => repo.projectRepositoryId === factorySessionState?.projectRepositoryId,
  );
  const factoryProjectId = factorySessionState?.factoryProjectId;
  const factoryProjectKey = typeof factoryProjectId === 'string' ? factoryProjectId : undefined;
  const workItems = useSessionWorkItemsQuery(factoryProjectKey, sessionId);
  const currentItem = workItems.data?.find(item =>
    Object.values(item.sessions).some(session => session.threadId === threadId),
  );

  return (
    <div
      aria-label={t('status.line')}
      // Shares the composer's footer row with the send buttons: it takes the room left and wraps
      // inside it, so the buttons never drop to a row of their own. `@container/status` lets each
      // stat drop its secondary reading when the row is narrow (tooltips and popovers still say it).
      className="@container/status text-caption text-muted-foreground flex h-fit min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-1"
    >
      <ModelPicker />
      <ModelCredential />
      <OperationalMemoryStatus />
      <SessionUsageStatus />
      <UsageLimitsStatus />
      <RuntimeActivity />
      <ConnectionActivity />
      <QueuedFollowUps />
      <GoalStatus />
      {!workItems.isLoading && (!currentItem || !isPullRequestSource(currentItem.source)) ? (
        <PullRequestLinks repository={repository} threadId={threadId} />
      ) : null}
    </div>
  );
}
