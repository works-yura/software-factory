import { MarkdownRenderer } from '@mastra/playground-ui/components/MarkdownRenderer';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { CardContextSession } from '../boardItems';
import { itemBoard } from '../boardStages';
import type { ReworkReason } from '../reworkReason';
import type { AuditActorProfile, AuditEvent } from '../services/audit';
import { factoryAttentionTargetPath } from '../services/attention';
import type { WorkItem } from '../services/workItems';
import { CardSourceDescription, useSourceDescription } from './BoardCardDetails';
import { CardAttachments } from './CardAttachments';
import { CardSessions } from './CardSessions';
import { WorkItemDescription } from './WorkItemDescription';
import { CommentComposer } from './feed/CommentComposer';
import { CommentList } from './feed/CommentList';
import type { FeedUser } from './feed/CommentList';
import type { CommentQuoteDraft } from './feed/quoteDraft';
import { Txt } from '@mastra/playground-ui/components/Txt';

// One stream in time order, runs and moves and comments alike, the composer under it.
export function WorkItemTray({
  item,
  factoryId,
  projectRepositoryId,
  enabled,
  currentUser,
  highlightCommentId,
  events,
  actors,
  contextSessions,
  rework,
}: {
  item: WorkItem;
  factoryId: string;
  projectRepositoryId: string;
  /** Mounted only once the panel opens, so closed cards run no feed queries. */
  enabled: boolean;
  currentUser?: FeedUser;
  highlightCommentId?: string;
  events: AuditEvent[];
  actors: Record<string, AuditActorProfile>;
  contextSessions: readonly CardContextSession[];
  rework?: ReworkReason;
}) {
  const factoryProjectId = factoryId || undefined;
  const [quote, setQuote] = useState<CommentQuoteDraft>();
  const description = useSourceDescription(item, projectRepositoryId, factoryProjectId);

  return (
    <>
      <CommentList
        item={item}
        factoryProjectId={factoryProjectId}
        enabled={enabled}
        currentUser={currentUser}
        highlightCommentId={highlightCommentId}
        events={events}
        actors={actors}
        leadingLoaded={description === undefined || !description.isPending}
        leading={
          <div className="bg-fill mx-1 my-2 flex flex-col gap-2 rounded-lg p-3">
            <Txt as="h3" variant="card-title" tone="ink" className="m-0 wrap-anywhere">
              {item.title}
            </Txt>
            <WorkItemDescription item={item} factoryProjectId={factoryProjectId} />
            <CardSourceDescription
              item={item}
              projectRepositoryId={projectRepositoryId}
              factoryProjectId={factoryProjectId}
            />
            {rework && <WhyItMovedBack rework={rework} />}
            <CardSessions factoryId={factoryId} sessions={contextSessions} />
            <CardAttachments workItemId={item.id} enabled={enabled} />
          </div>
        }
        commentUrl={commentId =>
          `${window.location.origin}${factoryAttentionTargetPath(factoryId, {
            kind: 'work-item',
            board: itemBoard(item),
            workItemId: item.id,
            commentId,
          })}`
        }
        onQuote={setQuote}
        className="min-h-0 grow px-1"
      />
      <div className="p-2">
        <CommentComposer
          workItemId={item.id}
          factoryProjectId={factoryProjectId}
          variant="panel"
          quote={quote}
          onDismissQuote={() => setQuote(undefined)}
        />
      </div>
    </>
  );
}

function WhyItMovedBack({ rework }: { rework: ReworkReason }) {
  const { t } = useTranslation('board');
  return (
    <section aria-label={t('rework.sectionLabel')} className="flex flex-col gap-1">
      <Txt as="h4" variant="eyebrow" tone="muted" className="m-0">
        {t('rework.title', { phase: rework.fromLabel })}
      </Txt>
      {rework.reason ? (
        <MarkdownRenderer className="text-foreground text-caption max-w-none [&>*:first-child]:mt-0">
          {rework.reason}
        </MarkdownRenderer>
      ) : (
        <Txt variant="meta" tone="muted" className="m-0">
          {t(`rework.movedBy.${rework.movedBy}`)}
        </Txt>
      )}
    </section>
  );
}
