import { DEFAULT_BOARD_ID } from '@factory/core/boards/default-board';
import { relatedCardIndex } from '@factory/core/related-cards';
import type { PullRequestFacts } from '@factory/core/related-cards';
import { gitlabIdentifierForItem, githubNumberForItem, sourceMetadata, workItemKey } from '../boardItems';
import { rememberedBoardPath } from './boardViews';
import type { WorkItem } from './workItems';
import { isPullRequestSource } from './workItems';
import { translator } from '../../../i18n/t';

const tk = translator('board');

/** Intake candidates carry a source and metadata but no card, so identifiers work on both. */
type IdentifiableItem = Pick<WorkItem, 'source' | 'workItem' | 'metadata' | 'sourceKey'>;

export function workItemNumber(item: IdentifiableItem): string | undefined {
  const githubNumber = githubNumberForItem(item);
  if (githubNumber !== undefined) return String(githubNumber);
  if (item.source === 'gitlab-pr') {
    const iid = sourceMetadata(item).gitlabMergeRequestIid;
    return typeof iid === 'number' && Number.isSafeInteger(iid) && iid > 0 ? String(iid) : undefined;
  }

  const number = sourceMetadata(item).number;
  if (typeof number === 'number' || typeof number === 'string') return String(number);
  return item.sourceKey?.split(':').at(-1) || undefined;
}

const PULL_REQUEST_FACTS: PullRequestFacts<WorkItem> = {
  isPullRequest: item => isPullRequestSource(item.source),
  headBranch: item => {
    const branch = sourceMetadata(item).headBranch;
    return typeof branch === 'string' ? branch : undefined;
  },
};

/** Relations across `allItems`, read the way the server reads them to scope a session's cards. */
export function relatedWorkItemIndex(allItems: readonly WorkItem[]): (item: WorkItem) => WorkItem[] {
  return relatedCardIndex(allItems, PULL_REQUEST_FACTS);
}

export function inferredParentWorkItemId(
  metadata: Record<string, unknown>,
  allItems: readonly WorkItem[],
): string | undefined {
  const headBranch = metadata.headBranch;
  if (typeof headBranch !== 'string') return undefined;
  return allItems.find(
    item =>
      !isPullRequestSource(item.source) && Object.values(item.sessions).some(session => session.branch === headBranch),
  )?.id;
}

/** A pull request opens the board that holds its card; an unfiled one, or one with no board, opens the default board. */
export function relationshipPath(
  item: Pick<WorkItem, 'source'> & { readonly board?: string | null },
  factoryId: string,
): string {
  if (!isPullRequestSource(item.source) || item.board === undefined)
    return rememberedBoardPath(factoryId, DEFAULT_BOARD_ID);
  return rememberedBoardPath(factoryId, item.board ?? DEFAULT_BOARD_ID);
}

export function relationshipLabel(item: WorkItem): string {
  const reference = workItemReferenceLabel(item) ?? item.title;
  return isPullRequestSource(item.source)
    ? tk('relationship.review', { reference })
    : tk('relationship.workItem', { reference });
}

/** What a person types to find the item: `#20456` on GitHub, `!12` on GitLab, the provider key elsewhere (ClickUp). */
export function workItemIdentifier(item: IdentifiableItem): string | undefined {
  if (item.source === 'gitlab-pr') return gitlabIdentifierForItem(item);
  if (item.source === 'github-pr' || item.source === 'github-issue') {
    const number = workItemNumber(item);
    return number ? `#${number}` : undefined;
  }
  return workItemKey(item);
}

export function workItemReferenceLabel(item: IdentifiableItem): string | undefined {
  const identifier = workItemIdentifier(item);
  if (identifier === undefined) return;
  if (item.source === 'github-pr') return `PR ${identifier}`;
  if (item.source === 'gitlab-pr') return `MR ${identifier}`;
  if (item.source === 'github-issue') return tk('relationship.issue', { identifier });
  return identifier;
}
