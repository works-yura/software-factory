import { toast } from '@mastra/playground-ui/components/Toaster';
import { DropdownMenu } from '@mastra/playground-ui/components/DropdownMenu';
import { HoverCard, HoverCardTrigger } from '@mastra/playground-ui/components/HoverCard';
import { Sidebar, useMaybeSidebar } from '@mastra/playground-ui/components/Sidebar';
import { PullRequestIcon } from '@mastra/playground-ui/components/PullRequestIcon';
import { Spinner } from '@mastra/playground-ui/components/Spinner';
import { cn } from '@mastra/playground-ui/utils/cn';
import { Lock, MessageSquarePlus, MoreHorizontal, Pin, PinOff, RefreshCw, Trash2, User, Users } from 'lucide-react';
import { useId, useRef } from 'react';
import type { ReactNode, RefObject } from 'react';
import { useTranslation } from 'react-i18next';

import { addFactoryRef, writeDraggedRef } from '../../chat/services/factoryRefs';
import type { FactoryRef } from '../../chat/services/factoryRefs';
import { SourceIcon } from '../../factory/components/BoardIcons';
import { PullRequestStatusIcon } from '../../factory/components/PullRequestStatusIcon';
import type { SessionSource } from '../services/sessionPresentation';
import type { SessionPullRequest } from '../services/sessionRows';
import type { SessionRowStatus } from '../services/sessionStatus';
import { ActivityBelt } from '@mastra/playground-ui/components/Activity';
import { SessionPreviewCard } from './SessionPreviewCard';
import type { SessionPreviewDetails } from './SessionPreviewCard';
import { SessionSharingPopover } from './SessionSharingPopover';
import { translator } from '../../../i18n/t';

const tk = translator('workspaces');
import { relativeTime } from '../../../../lib/date/relativeTime';
import type { PullRequestStatus } from '../../factory/boardItems';
import { isPullRequestSource } from '../../factory/services/workItems';

/**
 * Shared sidebar row for workspace/user sessions. Built on `Sidebar.NavLink`
 * so every session list (work, review, user) renders with identical density,
 * hover, and active states. Lifecycle lives on the left as an activity belt;
 * the trailing slot beside the label is left to the spinner, the merge badge
 * and the actions menu, which swap in place and collapse the slot when there is
 * nothing to show so the label gets the full row. Because that slot comes and
 * goes, the belt, the menu and the preview card anchor to the row box instead —
 * a resized or hidden anchor would drag them across the screen.
 */
export function SessionNavRow({
  name,
  label,
  level,
  title,
  url,
  source,
  active,
  disabled,
  loading,
  status,
  merged,
  changeRequestProvider = 'github',
  preview: previewDetails,
  pinned = false,
  onSelect,
  onPinChange,
  onDelete,
  onRegenerateTitle,
  regeneratingTitle,
  visibility,
  onVisibilityChange,
  changingVisibility,
  reference,
  pullRequest,
  updatedAt,
  compact,
  subItems,
}: {
  name: string;
  /** Shown instead of the name, which stays in the accessible name: a child session's phase. */
  label?: string;
  /** Indent level: 1 for a card's child sessions. */
  level?: number;
  /** Hover tooltip, typically the branch name. */
  title?: string;
  url: string;
  /** Leading icon: a user session, or the source of the session's work item. */
  source?: SessionSource;
  active: boolean;
  disabled: boolean;
  /** True while this row's async open is in flight — shows a spinner and blocks clicks. */
  loading?: boolean;
  /** Merged change request for this session's branch — shown only when the row is otherwise idle. */
  merged?: boolean;
  /** Names the merged badge: GitHub pull requests or GitLab merge requests. */
  changeRequestProvider?: 'github' | 'gitlab';
  status?: SessionRowStatus;
  preview?: SessionPreviewDetails;
  pinned?: boolean;
  onSelect: () => void;
  onPinChange: (pinned: boolean) => void;
  /** Omit on sessions the viewer does not own: the server only lets owners delete. */
  onDelete?: () => void;
  /** Omitted for sessions the viewer does not own: the server only lets owners rename. */
  onRegenerateTitle?: () => void;
  regeneratingTitle?: boolean;
  /** Private rows show a sharing popover; shared rows have no visibility badge. */
  visibility?: 'org' | 'private';
  /** Omitted for sessions the viewer does not own: the server only lets owners change visibility. */
  onVisibilityChange?: (visibility: 'org' | 'private') => void;
  /** Disables the visibility item while a change is in flight, so overlapping requests cannot land out of order. */
  changingVisibility?: boolean;
  /** What the row stands for in a chat: dragging it into the composer, or "Add to chat", references it. */
  reference?: FactoryRef;
  /** The change request the session's card is, or links to. */
  pullRequest?: SessionPullRequest;
  /** When the session last moved, shown on the second line. */
  updatedAt: string;
  /** Single-line row; otherwise a second line shows when it last moved and its change request. */
  compact: boolean;
  /** Rows nested under this one: a card's child sessions. */
  subItems?: ReactNode;
}) {
  const { t } = useTranslation('workspaces');
  // The row box, not the list item, which also holds any nested rows.
  const anchor = useRef<HTMLSpanElement>(null);
  const statusId = useId();
  // Selecting a session navigates away, so the mobile nav drawer must close.
  const sidebar = useMaybeSidebar();
  // Touch has no hover: the card would only open behind the tap that already navigated away.
  const preview = sidebar?.isMobile ? undefined : previewDetails;
  // The live merge check lands before the work item catches up, so it wins over the item's state
  // either way; when it says not merged, the item's stale merged state is dropped rather than guessed.
  const pullRequestStatus = merged
    ? 'merged'
    : merged === false && pullRequest?.status === 'merged'
      ? undefined
      : pullRequest?.status;
  const statusAt = pullRequestPlacement({ source, pullRequest, pullRequestStatus, compact, merged, loading, status });
  const statusLabel =
    (statusAt === 'icon' || statusAt === 'line') && pullRequestStatus
      ? changeRequestLabel(pullRequestStatus, pullRequest)
      : undefined;
  const button = (
    <button
      type="button"
      aria-current={active ? 'page' : undefined}
      aria-label={label ? `${label}: ${name}` : name}
      aria-describedby={statusLabel ? statusId : undefined}
      disabled={disabled || loading}
      onClick={() => {
        sidebar?.setOpenMobile(false);
        onSelect();
      }}
      title={preview ? undefined : title}
      draggable={reference ? true : undefined}
      onDragStart={reference ? event => writeDraggedRef(event.dataTransfer, reference) : undefined}
    >
      {source ? (
        <SessionSourceIcon source={source} pullRequestStatus={statusAt === 'icon' ? pullRequestStatus : undefined} />
      ) : null}
      <Sidebar.NavLabel
        description={
          compact ? undefined : (
            <SessionMetaLine
              updatedAt={updatedAt}
              pullRequest={pullRequest}
              status={statusAt === 'line' ? pullRequestStatus : undefined}
            />
          )
        }
      >
        {label ?? name}
      </Sidebar.NavLabel>
      {pinned && !loading ? (
        <Pin aria-label={t('sessionRow.pinned', { name })} className="text-muted-foreground/70 size-2 shrink-0 rotate-45" />
      ) : null}
      {statusLabel ? (
        <span id={statusId} hidden>
          {statusLabel}
        </span>
      ) : null}
    </button>
  );
  const belt = loading ? undefined : status;
  const trailing = loading ? 'loading' : statusAt === 'badge' ? 'merged' : undefined;
  const mergedLabel =
    changeRequestProvider === 'gitlab' ? t('sessionRow.mergeRequestMerged') : t('sessionRow.pullRequestMerged');
  const mergedAriaLabel =
    changeRequestProvider === 'gitlab'
      ? t('sessionRow.mergeRequestMergedFor', { name })
      : t('sessionRow.pullRequestMergedFor', { name });
  const action = (
    <>
      <span ref={anchor} aria-hidden className="pointer-events-none absolute inset-0" />
      {belt ? <ActivityBelt status={belt} label={beltLabel(belt, name)} /> : null}
      {visibility === 'private' ? (
        <SessionSharingPopover
          name={name}
          disabled={disabled || loading}
          onShare={onVisibilityChange ? () => onVisibilityChange('org') : undefined}
          sharing={changingVisibility}
        />
      ) : null}
      <span className={cn(trailingSlot, trailing ? 'grid' : revealedSlot)}>
        {trailing === 'loading' ? (
          <Spinner size="sm" aria-label={t('sessionRow.opening', { name })} className="text-muted-foreground" />
        ) : null}
        {trailing === 'merged' ? (
          <span
            role="img"
            aria-label={mergedAriaLabel}
            title={mergedLabel}
            className={cn('flex', yieldsToActions)}
          >
            <PullRequestStatusIcon status="merged" className="size-3!" decorative />
          </span>
        ) : null}
        {trailing === 'loading' ? null : (
          <SessionActionsMenu
            name={name}
            anchor={anchor}
            disabled={disabled}
            pinned={pinned}
            onPinChange={onPinChange}
            onDelete={onDelete}
            onRegenerateTitle={onRegenerateTitle}
            regeneratingTitle={regeneratingTitle}
            visibility={visibility}
            onVisibilityChange={onVisibilityChange}
            changingVisibility={changingVisibility}
            reference={reference}
          />
        )}
      </span>
    </>
  );
  const row = (
    <Sidebar.NavLink
      link={{ name, url }}
      isActive={active}
      level={level}
      // 0ms both ways — each row owns its card, so a close delay leaves the previous one up while the next opens
      render={preview ? <HoverCardTrigger delay={0} closeDelay={0} render={button} /> : button}
      action={action}
      subItems={subItems}
    />
  );

  if (!preview) return row;

  return (
    <HoverCard>
      {row}
      <SessionPreviewCard name={name} anchor={anchor} status={status} merged={merged} details={preview} />
    </HoverCard>
  );
}

type PullRequestPlacement = 'icon' | 'line' | 'badge' | undefined;

/**
 * Where a row draws its change request's state, once: the leading icon of a card that is
 * the change request, the second line of an expanded row, or a merged badge on a compact
 * row with no lifecycle left to report.
 */
function pullRequestPlacement({
  source,
  pullRequest,
  pullRequestStatus,
  compact,
  merged,
  loading,
  status,
}: {
  source?: SessionSource;
  pullRequest?: SessionPullRequest;
  pullRequestStatus?: PullRequestStatus;
  compact: boolean;
  merged?: boolean;
  loading?: boolean;
  status?: SessionRowStatus;
}): PullRequestPlacement {
  if (pullRequestStatus && source && isPullRequestSource(source)) return 'icon';
  if (pullRequestStatus && pullRequest && !compact) return 'line';
  if (merged && !loading && !status) return 'badge';
  return undefined;
}

function changeRequestReference(pullRequest: SessionPullRequest | undefined) {
  if (pullRequest?.number === undefined) return undefined;
  return `${pullRequest.provider === 'gitlab' ? '!' : '#'}${pullRequest.number}`;
}

function changeRequestLabel(status: PullRequestStatus, pullRequest: SessionPullRequest | undefined) {
  const label = tk(`sessionRow.changeRequest.${pullRequest?.provider ?? 'github'}.${status}`);
  const reference = changeRequestReference(pullRequest);
  return reference ? `${label} ${reference}` : label;
}

/** The link describes the change request itself, so the line only draws it. */
function SessionMetaLine({
  updatedAt,
  pullRequest,
  status,
}: {
  updatedAt: string;
  pullRequest: SessionPullRequest | undefined;
  /** Omitted when the leading icon already shows the change request's state. */
  status: PullRequestStatus | undefined;
}) {
  const reference = changeRequestReference(pullRequest);
  return (
    <>
      <time dateTime={updatedAt} className="tabular-nums">
        {relativeTime(updatedAt)}
      </time>
      {status || reference ? (
        <span aria-hidden className="flex items-center gap-0.5 tabular-nums">
          {status ? <PullRequestStatusIcon status={status} decorative /> : null}
          {reference}
        </span>
      ) : null}
    </>
  );
}

function SessionSourceIcon({
  source,
  pullRequestStatus,
}: {
  source: SessionSource;
  pullRequestStatus?: PullRequestStatus;
}) {
  if (source === 'user') {
    return <User data-source="user" aria-hidden className="text-muted-foreground size-3.5 shrink-0" />;
  }
  if (pullRequestStatus) {
    return <PullRequestIcon data-source={source} status={pullRequestStatus} aria-hidden className="size-3.5" />;
  }
  return <SourceIcon source={source} className="size-3.5" />;
}

// As wide as `Sidebar.NavAction`, so swapping the badge for the menu never moves the label.
const trailingSlot = 'size-6 shrink-0 grid-rows-1 place-items-center *:col-start-1 *:row-start-1';

// An empty slot claims no width, so the label runs the full row until there is something to show.
const revealedSlot =
  'grid pointer-fine:hidden group-focus-within/nav-row:grid group-hover/nav-row:grid group-has-[[data-popup-open]]/nav-row:grid';

function beltLabel(status: SessionRowStatus, name: string) {
  if (status === 'initializing') return tk('sessionRow.initializing', { name });
  if (status === 'working') return tk('sessionRow.agentWorking', { name });
  return tk('sessionRow.waitingOnYou', { name });
}

function SessionActionsMenu({
  name,
  anchor,
  disabled,
  pinned,
  onPinChange,
  onDelete,
  onRegenerateTitle,
  regeneratingTitle,
  visibility,
  onVisibilityChange,
  changingVisibility,
  reference,
}: {
  name: string;
  anchor: RefObject<HTMLElement | null>;
  disabled: boolean;
  pinned: boolean;
  onPinChange: (pinned: boolean) => void;
  onDelete?: () => void;
  onRegenerateTitle?: () => void;
  regeneratingTitle?: boolean;
  visibility?: 'org' | 'private';
  onVisibilityChange?: (visibility: 'org' | 'private') => void;
  changingVisibility?: boolean;
  reference?: FactoryRef;
}) {
  const { t } = useTranslation('workspaces');
  return (
    <DropdownMenu>
      <DropdownMenu.Trigger
        render={
          <Sidebar.NavAction
            aria-label={t('sessionRow.actions', { name })}
            disabled={disabled}
            className="group-focus-within/nav-row:flex group-hover/nav-row:flex data-[popup-open]:flex pointer-fine:hidden"
          >
            <MoreHorizontal />
          </Sidebar.NavAction>
        }
      />
      <DropdownMenu.Content anchor={anchor} align="end">
        {reference ? (
          <DropdownMenu.Item
            onClick={() => {
              if (!addFactoryRef(reference)) toast.error(t('sessionRow.noComposer', { name }));
            }}
          >
            <MessageSquarePlus />
            {t('sessionRow.addToChat')}
          </DropdownMenu.Item>
        ) : null}
        <DropdownMenu.Item onClick={() => onPinChange(!pinned)}>
          {pinned ? <PinOff /> : <Pin />}
          {pinned ? t('sessionRow.unpin') : t('sessionRow.pin')}
        </DropdownMenu.Item>
        {onRegenerateTitle ? (
          <DropdownMenu.Item disabled={regeneratingTitle} onClick={onRegenerateTitle}>
            <RefreshCw className={cn(regeneratingTitle && 'animate-spin')} />
            {t('sessionRow.regenerateTitle')}
          </DropdownMenu.Item>
        ) : null}
        {onVisibilityChange && visibility ? (
          <DropdownMenu.Item
            disabled={changingVisibility}
            onClick={() => onVisibilityChange(visibility === 'private' ? 'org' : 'private')}
          >
            {visibility === 'private' ? <Users /> : <Lock />}
            {visibility === 'private' ? t('sharing.shareWithOrg') : t('sharing.makePrivate')}
          </DropdownMenu.Item>
        ) : null}
        {onDelete ? (
          <DropdownMenu.Item variant="destructive" onClick={onDelete}>
            <Trash2 />
            {t('actions.delete')}
          </DropdownMenu.Item>
        ) : null}
      </DropdownMenu.Content>
    </DropdownMenu>
  );
}

// The actions menu owns the slot as soon as the row is hovered, focused, or its menu is open.
const yieldsToActions =
  'pointer-coarse:hidden group-hover/nav-row:hidden group-focus-within/nav-row:hidden group-has-[[data-popup-open]]/nav-row:hidden';
