import { Button } from '@mastra/playground-ui/components/Button';

import { changeRequestNumberForItem, sourceMetadata } from '../../factory/boardItems';
import { PullRequestStatusIcon } from '../../factory/components/PullRequestStatusIcon';
import type { ChangeRequestProvider, PullRequestSubscription } from '../../factory/services/githubSubscriptions';
import type { WorkItem } from '../../factory/services/workItems';
import type { LinkedRepositoryPayload } from '../../workspaces/services/github';
import { usePullRequestSubscriptions } from '../hooks/usePullRequestSubscriptions';
import { translator } from '../../../i18n/t';

const tk = translator('chat');

interface PullRequestLinksProps {
  repository?: Pick<LinkedRepositoryPayload, 'slug' | 'provider'>;
  reviewItem?: WorkItem;
  threadId: string | undefined;
}

/** Provider vocabulary: GitHub numbers pull requests `#n`, GitLab numbers merge requests `!n`. */
const CHANGE_REQUEST_PREFIX: Record<ChangeRequestProvider, string> = {
  github: 'PR #',
  gitlab: 'MR !',
};

function reviewStatus(reviewItem: WorkItem): PullRequestSubscription['status'] {
  const metadata = sourceMetadata(reviewItem);
  if (metadata.state === 'merged' || metadata.merged === true) return 'merged';
  if (metadata.state === 'closed') return 'closed';
  return 'open';
}

function reviewSubscription(
  reviewItem: WorkItem | undefined,
  repositorySlug: string | undefined,
  provider: ChangeRequestProvider,
): PullRequestSubscription | undefined {
  if (!reviewItem || !repositorySlug) return undefined;

  const number = changeRequestNumberForItem(reviewItem);
  if (number === undefined) return undefined;

  // GitHub URLs are canonical from the slug; a GitLab instance can live on any
  // host, so only the card's own URL names the merge request.
  const url = provider === 'github' ? `https://github.com/${repositorySlug}/pull/${number}` : reviewItem.url;
  if (!url) return undefined;

  return {
    id: `factory-work-item:${reviewItem.id}`,
    repoFullName: repositorySlug,
    pullRequestNumber: number,
    status: reviewStatus(reviewItem),
    url,
  };
}

function pullRequestLinks(
  subscriptions: PullRequestSubscription[],
  activeReview: PullRequestSubscription | undefined,
): PullRequestSubscription[] {
  if (!activeReview) return subscriptions;

  // repository slugs are case-insensitive — factory config and the subscriptions endpoint can disagree on case
  const activeRepo = activeReview.repoFullName.toLowerCase();
  const alreadySubscribed = subscriptions.some(
    subscription =>
      subscription.repoFullName.toLowerCase() === activeRepo &&
      subscription.pullRequestNumber === activeReview.pullRequestNumber,
  );
  if (alreadySubscribed) return subscriptions;
  return [...subscriptions, activeReview];
}

/**
 * Change requests subscribed to the active repository-backed thread: GitHub
 * pull requests or GitLab merge requests, depending on the linked repository.
 *
 * Must render inside `ChatSessionBoundary` — `usePullRequestSubscriptions`
 * reads the chat session and transcript contexts.
 */
export function PullRequestLinks({ repository, reviewItem, threadId }: PullRequestLinksProps) {
  const provider: ChangeRequestProvider = repository?.provider === 'gitlab' ? 'gitlab' : 'github';
  const subscriptions = usePullRequestSubscriptions(threadId, Boolean(repository), provider);
  const activeReview = reviewSubscription(reviewItem, repository?.slug, provider);
  const links = pullRequestLinks(subscriptions, activeReview);
  if (links.length === 0) return null;
  const prefix = CHANGE_REQUEST_PREFIX[provider];
  const noun = tk(`changeRequest.nouns.${provider}`);
  // A session spanning several repositories opens one change request in each;
  // the bare number no longer says which repository it is in.
  const severalRepositories = new Set(links.map(link => link.repoFullName.toLowerCase())).size > 1;

  return (
    <div className="ml-auto flex items-center gap-2">
      {links.map(subscription => (
        <Button
          key={subscription.id}
          as="a"
          variant="ghost"
          size="sm"
          href={subscription.url}
          target="_blank"
          rel="noreferrer"
          aria-label={tk('changeRequest.open', {
            status: tk(`changeRequest.statuses.${subscription.status}`),
            repo: subscription.repoFullName,
            noun,
            number: subscription.pullRequestNumber,
          })}
        >
          <PullRequestStatusIcon status={subscription.status} size={13} decorative />
          <span>
            {severalRepositories ? `${subscription.repoFullName.split('/').at(-1)} ` : ''}
            {prefix}
            {subscription.pullRequestNumber}
          </span>
        </Button>
      ))}
    </div>
  );
}
