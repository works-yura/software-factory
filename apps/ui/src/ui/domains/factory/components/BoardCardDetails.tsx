import { MarkdownRenderer } from '@mastra/playground-ui/components/MarkdownRenderer';
import { Skeleton } from '@mastra/playground-ui/components/Skeleton';

import { useGitHubIssueDetail, useGitHubPullRequestDetail } from '../../../../hooks/useFactoryData';
import { useGitLabIssueDetail, useGitLabMergeRequestDetail } from '../../../../hooks/useGitLabData';
import { githubNumberForItem } from '../boardItems';
import type { WorkItem } from '../services/workItems';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { translator } from '../../../i18n/t';

const tk = translator('board');

/** The card's source and metadata — a work item or an unfiled candidate. */
type SourceItem = Pick<WorkItem, 'source' | 'sourceKey' | 'metadata'>;

function descriptionSource(
  item: SourceItem,
): 'issue' | 'pull' | 'gitlab' | 'gitlab-pr' | undefined {
  if (githubNumberForItem(item) !== undefined) {
    if (item.source === 'github-issue') return 'issue';
    if (item.source === 'github-pr') return 'pull';
  }
  if (item.source === 'gitlab-issue' && item.sourceKey) return 'gitlab';
  if (item.source === 'gitlab-pr' && typeof item.metadata.gitlabMergeRequestIid === 'number') return 'gitlab-pr';
  return undefined;
}

/** The body behind the card; undefined for sources with none to fetch (manual, Slack). */
export function useSourceDescription(
  item: SourceItem,
  projectRepositoryId: string | undefined,
  factoryProjectId: string | undefined,
) {
  const number = githubNumberForItem(item);
  const gitlabIssueId = item.source === 'gitlab-issue' ? (item.sourceKey ?? undefined) : undefined;
  const source = descriptionSource(item);
  const issue = useGitHubIssueDetail(
    source === 'issue' ? projectRepositoryId : undefined,
    source === 'issue' ? number : undefined,
  );
  const pull = useGitHubPullRequestDetail(
    source === 'pull' ? projectRepositoryId : undefined,
    source === 'pull' ? number : undefined,
  );
  const gitlab = useGitLabIssueDetail(
    source === 'gitlab' ? factoryProjectId : undefined,
    source === 'gitlab' ? gitlabIssueId : undefined,
  );
  const gitlabPull = useGitLabMergeRequestDetail(
    source === 'gitlab-pr' ? factoryProjectId : undefined,
    source === 'gitlab-pr' ? projectRepositoryId : undefined,
    source === 'gitlab-pr' ? (item.metadata.gitlabMergeRequestIid as number) : undefined,
  );
  return source === undefined ? undefined : { issue, pull, gitlab, 'gitlab-pr': gitlabPull }[source];
}

export function CardSourceDescription({
  item,
  projectRepositoryId,
  factoryProjectId,
}: {
  item: SourceItem;
  projectRepositoryId: string | undefined;
  factoryProjectId: string | undefined;
}) {
  const query = useSourceDescription(item, projectRepositoryId, factoryProjectId);
  if (query === undefined) return null;

  if (query.isPending) {
    return (
      <div className="flex flex-col gap-1.5" aria-hidden>
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-4/5" />
        <Skeleton className="h-3 w-2/3" />
      </div>
    );
  }
  if (query.isError) {
    return (
      <Txt variant="meta" tone="muted" className="m-0">
        {tk('card.descriptionFailed')}
      </Txt>
    );
  }
  const description = query.data?.description ?? null;
  if (description === null || description.trim() === '') return null;
  return (
    <MarkdownRenderer className="text-foreground text-caption max-w-none [&>*:first-child]:mt-0">
      {description}
    </MarkdownRenderer>
  );
}
