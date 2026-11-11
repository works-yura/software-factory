import { Txt } from '@mastra/playground-ui/components/Txt';
import { Crumb } from '@mastra/playground-ui/components/Breadcrumb';
import { Button } from '@mastra/playground-ui/components/Button';
import { focusRing } from '@mastra/playground-ui/primitives/transitions';
import { Link2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useMatch, useNavigate, useParams } from 'react-router';

import { useBoardCatalog } from '../../../../hooks/useBoardCatalog';
import { useUserSessionQuery, useWorkspacesQuery } from '../../../../hooks/useWorkspaces';
import { useSessionWorkItemsQuery } from '../../../../hooks/useWorkItems';
import { boardTitle } from '../../../i18n/boardLabels';
import { translator } from '../../../i18n/t';
import { ChatPageLayout } from '../../chat/components/ChatPageLayout';
import { getUserSessionLabel } from '../../workspaces/services/sessionPresentation';
import { UserSessionSharing } from '../../workspaces/components/UserSessionSharing';
import { WorkspaceFilesToggle } from '../../workspace-viewer/components/WorkspaceFilesToggle';
import { cardContextSessions, phaseContext, phaseLabel } from '../boardItems';
import type { CardContextSession, ContextPhase } from '../boardItems';
import { itemBoard } from '../boardStages';
import { rememberedBoardPath } from '../services/boardViews';
import { relatedWorkItemIndex, relationshipLabel, relationshipPath, workItemNumber } from '../services/relationships';
import type { CardPullRequestLink, WorkItem, WorkItemSessionRef } from '../services/workItems';
import { cardPullRequestLinks, isPullRequestSource } from '../services/workItems';
import { genericExternalWorkItemUrl } from '../services/workItemPresentation';
import { SourceIcon } from './BoardIcons';
import { FactoryReviewPullRequestLinks } from './FactoryReviewPullRequestLinks';
import { SessionContextMenu, cardSessionPath } from './SessionContextMenu';

const tk = translator('board');

function latestLiveSession(item: WorkItem, livePaths: ReadonlySet<string>): WorkItemSessionRef | undefined {
  return Object.values(item.sessions)
    .filter(session => livePaths.has(session.sessionId))
    .at(-1);
}

function sessionTitle(item: WorkItem): string {
  const number = workItemNumber(item);
  if (item.source === 'github-pr' && number) return `PR #${number}: ${item.title}`;
  if (item.source === 'gitlab-pr' && number) return `MR !${number}: ${item.title}`;
  if (item.source === 'github-issue' && number) return tk('relatedSessions.issueTitle', { number, title: item.title });
  return item.title;
}

function externalWorkItemLabel(item: WorkItem): string {
  const number = workItemNumber(item);
  if (item.source === 'github-pr') return number ? `PR #${number}` : tk('relatedSessions.pullRequest');
  if (item.source === 'gitlab-pr') return number ? `MR !${number}` : tk('relatedSessions.mergeRequest');
  if (item.source === 'github-issue')
    return number ? tk('relatedSessions.issueNumber', { number }) : tk('relatedSessions.issue');
  return tk('relatedSessions.workItem');
}

function pullRequestLinkLabel(pullRequest: CardPullRequestLink): string {
  const kind = pullRequest.provider === 'gitlab' ? 'MR' : 'PR';
  const reference =
    pullRequest.number === undefined
      ? kind
      : `${kind} ${pullRequest.provider === 'gitlab' ? '!' : '#'}${pullRequest.number}`;
  return pullRequest.state === 'open' ? reference : `${reference} ${pullRequest.state}`;
}

function activeWorkItem(
  items: WorkItem[],
  factoryId?: string,
  sessionId?: string,
  threadId?: string,
): WorkItem | undefined {
  if (!factoryId || !sessionId || !threadId) return undefined;
  return items.find(item =>
    Object.values(item.sessions).some(session => session.threadId === threadId && session.sessionId === sessionId),
  );
}

interface SessionContextCrumb {
  label: string;
  /** Every session the card holds, one per context. */
  sessions: CardContextSession[];
  /** The phase the card is in, when that runs in another context, and that context's session. */
  cardPhase?: { name: string; session?: CardContextSession };
}

/** The context this session runs in, and the phase the card is in when that runs elsewhere. */
function sessionContextCrumb(
  item: WorkItem,
  phases: readonly ContextPhase[] | undefined,
  boardId: string,
  sessionId: string,
  threadId: string,
): SessionContextCrumb | undefined {
  const stage = item.stages[0];
  if (stage === undefined) return undefined;
  const sessions = cardContextSessions(item, phases, stage, boardId);
  const entry = sessions.find(
    candidate => candidate.ref.sessionId === sessionId && candidate.ref.threadId === threadId,
  );
  if (!entry) return undefined;
  const currentPhase = phases?.find(phase => phase.id === stage);
  // A context no phase runs in (self-review's `review`, legacy `plan`) is not
  // one the card moves out of, so the card being elsewhere says nothing.
  const phaseRunsHere = phases?.some(phase => phaseContext(phase) === entry.context);
  if (entry.current || !phaseRunsHere || !currentPhase || phaseContext(currentPhase) === undefined) {
    return { label: entry.label, sessions };
  }
  return {
    label: entry.label,
    sessions,
    cardPhase: {
      name: phaseLabel(currentPhase, boardId),
      session: sessions.find(candidate => candidate.current),
    },
  };
}

/** Chat page frame for a factory thread: breadcrumb of the work item or session, plus its actions. */
export function FactorySessionPage({ children }: { children: ReactNode }) {
  const { t } = useTranslation('board');
  const { factoryId, sessionId, threadId } = useParams<{ factoryId: string; sessionId: string; threadId: string }>();
  // User threads carry the session id as `threadId` (see ChatSessionProvider).
  const isUserThread = Boolean(useMatch('/factories/:factoryId/user/threads/:threadId'));
  const userSessionId = sessionId ?? threadId;
  const sessionQuery = useUserSessionQuery(userSessionId);
  const projectRepositoryId = sessionQuery.data?.projectRepositoryId;
  const items = useSessionWorkItemsQuery(factoryId, sessionId);
  const workspaces = useWorkspacesQuery(factoryId);
  const catalog = useBoardCatalog(factoryId);

  // The session's cards and the cards related to them, not the board.
  const sessionItems = items.data ?? [];
  const currentItem = activeWorkItem(sessionItems, factoryId, sessionId, threadId);
  // Prefer the list row: PageTitle patches it with the generated title, the detail cache is not updated.
  const session = workspaces.data?.userSessions.find(entry => entry.sessionId === userSessionId) ?? sessionQuery.data;
  const workspaceTitle = !isUserThread && !currentItem ? session?.title?.trim() : undefined;
  const livePaths = new Set((workspaces.data?.workspaces ?? []).map(workspace => workspace.sessionId));
  const currentBoard = currentItem && itemBoard(currentItem);
  const contextCrumb =
    currentItem && currentBoard && sessionId && threadId
      ? sessionContextCrumb(
          currentItem,
          catalog.data?.find(board => board.id === currentBoard)?.phases,
          currentBoard,
          sessionId,
          threadId,
        )
      : undefined;

  const crumbs =
    currentItem && factoryId ? (
      <>
        <Crumb as={Link} to={rememberedBoardPath(factoryId, currentBoard ?? 'work')}>
          {boardTitle(
            currentBoard ?? 'work',
            catalog.data?.find(board => board.id === (currentBoard ?? 'work'))?.title ?? 'Work',
          )}
        </Crumb>
        <Crumb as="span" isCurrent={!contextCrumb}>
          {sessionTitle(currentItem)}
        </Crumb>
        {contextCrumb && sessionId ? (
          <Crumb
            as="span"
            isCurrent
            switcher={
              contextCrumb.sessions.length > 1 ? (
                <SessionContextMenu factoryId={factoryId} sessions={contextCrumb.sessions} openSessionId={sessionId} />
              ) : undefined
            }
          >
            {contextCrumb.label}
          </Crumb>
        ) : null}
        {contextCrumb?.cardPhase ? (
          <li className="flex min-w-0 items-center px-2">
            {contextCrumb.cardPhase.session ? (
              <Link
                to={cardSessionPath(factoryId, contextCrumb.cardPhase.session)}
                className={`text-muted-foreground hover:text-foreground truncate rounded-sm ${focusRing}`}
              >
                <Txt as="span" variant="caption">
                  {t('relatedSessions.cardNowIn', { phase: contextCrumb.cardPhase.name })}
                </Txt>
              </Link>
            ) : (
              <Txt as="span" variant="caption" tone="muted" className="truncate">
                {t('relatedSessions.cardNowIn', { phase: contextCrumb.cardPhase.name })}
              </Txt>
            )}
          </li>
        ) : null}
      </>
    ) : isUserThread && session ? (
      <>
        <Crumb as="span">{t('relatedSessions.userSessions')}</Crumb>
        <Crumb as="span" isCurrent>
          {getUserSessionLabel(session)}
        </Crumb>
      </>
    ) : workspaceTitle ? (
      <>
        <Crumb as="span">{t('relatedSessions.sessions')}</Crumb>
        <Crumb as="span" isCurrent>
          {workspaceTitle}
        </Crumb>
      </>
    ) : undefined;

  return (
    <ChatPageLayout
      crumbs={crumbs}
      headerActions={
        <>
          {isUserThread && factoryId && session ? <UserSessionSharing factoryId={factoryId} session={session} /> : null}
          {currentItem && factoryId && threadId ? (
            <WorkItemActions
              item={currentItem}
              sessionItems={sessionItems}
              livePaths={livePaths}
              factoryId={factoryId}
              threadId={threadId}
              projectRepositoryId={projectRepositoryId}
            />
          ) : null}
          <WorkspaceFilesToggle />
        </>
      }
    >
      {children}
    </ChatPageLayout>
  );
}

function WorkItemActions({
  item,
  sessionItems,
  livePaths,
  factoryId,
  threadId,
  projectRepositoryId,
}: {
  item: WorkItem;
  sessionItems: WorkItem[];
  livePaths: ReadonlySet<string>;
  factoryId: string;
  threadId: string;
  projectRepositoryId?: string;
}) {
  const { t } = useTranslation('board');
  const navigate = useNavigate();
  const externalItemUrl = genericExternalWorkItemUrl(item);
  const externalItemLabel = externalWorkItemLabel(item);
  const relatedItems = relatedWorkItemIndex(sessionItems)(item);
  // A pull request with its own Review card already has a link, as does the card's own.
  const linkedUrls = new Set([externalItemUrl, ...relatedItems.map(related => related.url)]);
  const pullRequests = cardPullRequestLinks(item).filter(pullRequest => !linkedUrls.has(pullRequest.url));

  const openSession = (session: WorkItemSessionRef) => {
    void navigate(`/factories/${factoryId}/workspaces/${session.sessionId}/threads/${session.threadId}`);
  };

  return (
    <>
      {externalItemUrl ? (
        <Button
          as="a"
          variant="ghost"
          size="sm"
          href={externalItemUrl}
          target="_blank"
          rel="noreferrer"
          aria-label={t('relatedSessions.open', { label: externalItemLabel })}
        >
          <SourceIcon source={item.source} className="size-3.5" />
          {externalItemLabel}
        </Button>
      ) : null}
      {pullRequests.map(pullRequest => {
        const label = pullRequestLinkLabel(pullRequest);
        return (
          <Button
            key={pullRequest.url}
            as="a"
            variant="ghost"
            size="sm"
            href={pullRequest.url}
            target="_blank"
            rel="noreferrer"
            aria-label={`Open ${label}`}
          >
            <SourceIcon source={pullRequest.provider === 'gitlab' ? 'gitlab-pr' : 'github-pr'} className="size-3.5" />
            {label}
          </Button>
        );
      })}
      {relatedItems.map(related => {
        const label = relationshipLabel(related);
        const session = latestLiveSession(related, livePaths);

        if (!session) {
          return (
            <Link
              to={relationshipPath(related, factoryId)}
              aria-label={t('relatedSessions.openRelated', { label, title: related.title })}
              key={related.id}
              className="text-muted-foreground hover:bg-fill hover:text-foreground flex items-center gap-1.5 rounded-md px-2 py-1"
            >
              <Link2 size={13} aria-hidden />
              <Txt as="span" variant="caption" className="block">
                {label}
              </Txt>
            </Link>
          );
        }

        return (
          <Button
            key={related.id}
            type="button"
            variant="ghost"
            size="sm"
            aria-label={t('relatedSessions.openRelated', { label, title: related.title })}
            onClick={() => openSession(session)}
          >
            <Link2 size={13} aria-hidden />
            {label}
          </Button>
        );
      })}
      {isPullRequestSource(item.source) ? (
        <FactoryReviewPullRequestLinks
          factoryId={factoryId}
          projectRepositoryId={projectRepositoryId}
          reviewItem={item}
          threadId={threadId}
        />
      ) : null}
    </>
  );
}
