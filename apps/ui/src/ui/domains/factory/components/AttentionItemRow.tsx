import type { BadgeVariant } from '@mastra/playground-ui/components/Badge';
import { Badge } from '@mastra/playground-ui/components/Badge';
import { Button } from '@mastra/playground-ui/components/Button';
import { Spinner } from '@mastra/playground-ui/components/Spinner';
import { focusRingInset } from '@mastra/playground-ui/primitives/transitions';
import { cn } from '@mastra/playground-ui/utils/cn';
import {
  Archive,
  ArchiveRestore,
  Brain,
  Check,
  Hourglass,
  MailOpen,
  MessageSquare,
  MessagesSquare,
  RotateCw,
  Sparkles,
  TriangleAlert,
  X,
} from 'lucide-react';
import { createElement } from 'react';
import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';

import { relativeTime } from '../../../../lib/date/relativeTime';
import { attentionPrompt, supervisorAskPath } from '../../supervisor/services/supervisor';
import { attentionAuthorName, factoryAttentionTargetPath, readableAttentionDetail } from '../services/attention';
import type { FactoryAttentionItem } from '../services/attention';
import { RAIL_ROW_BODY } from './Timeline';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { useTranslation } from 'react-i18next';

import { lazyLabels } from '../../../i18n/lazy';
import { translator } from '../../../i18n/t';

const ta = translator('activity');

const KIND = {
  mention: { glyph: MessageSquare, badge: 'green' },
  activity: { glyph: MessagesSquare, badge: 'neutral' },
  'automation-failed': { glyph: TriangleAlert, badge: 'destructive' },
  'automation-proposed': { glyph: Sparkles, badge: 'orange' },
  'supervisor-finding': { glyph: Brain, badge: 'blue' },
  'agent-waiting': { glyph: Hourglass, badge: 'orange' },
} satisfies Record<FactoryAttentionItem['kind'], { glyph: typeof MessageSquare; badge: BadgeVariant }>;

const KIND_LABEL = lazyLabels(
  Object.keys(KIND) as Array<FactoryAttentionItem['kind']>,
  kind => `activity:attention.kinds.${kind}`,
);

/** Meta and actions stack in one grid cell, so a hover swaps them without reflow; touch has no hover, so they share a line under the title. */
const SWAP_SLOT =
  'relative grid shrink-0 items-center justify-items-end [grid-template-areas:"slot"] *:[grid-area:slot] pointer-coarse:flex pointer-coarse:w-full pointer-coarse:justify-between';

const HIDDEN_ON_REVEAL =
  'pointer-events-none transition-opacity duration-150 pointer-fine:group-hover:opacity-0 pointer-fine:group-focus-within:opacity-0';

const SHOWN_ON_REVEAL =
  'flex items-center gap-0.5 transition-opacity duration-150 pointer-fine:pointer-events-none pointer-fine:opacity-0 pointer-fine:group-hover:pointer-events-auto pointer-fine:group-hover:opacity-100 pointer-fine:group-focus-within:pointer-events-auto pointer-fine:group-focus-within:opacity-100';

function destinationLabel(item: FactoryAttentionItem): string {
  if (item.target.kind === 'thread') return ta('attention.openThreadFor', { title: item.title });
  if (item.target.kind === 'work-item') return ta('attention.viewCardFor', { title: item.title });
  return ta('attention.viewRulesFor', { title: item.title });
}

function RowAction({
  tooltip,
  label,
  disabled,
  onClick,
  children,
}: {
  tooltip: string;
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      disabled={disabled}
      tooltip={tooltip}
      aria-label={label}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

export function AttentionItemRow({
  factoryId,
  item,
  retrying,
  settling,
  updatingReceipt,
  onRetry,
  onChooseRepository,
  onApprove,
  onDismiss,
  onRead,
  onArchive,
  onRestore,
}: {
  factoryId: string;
  item: FactoryAttentionItem;
  retrying: boolean;
  settling: boolean;
  updatingReceipt: boolean;
  onRetry?: () => void;
  onChooseRepository?: () => void;
  onApprove?: () => void;
  onDismiss?: () => void;
  onRead: () => void;
  onArchive: () => void;
  onRestore: () => void;
}) {
  const navigate = useNavigate();
  const { t } = useTranslation('activity');
  const author = attentionAuthorName(item);

  return (
    <div
      className={cn(
        'group relative flex items-center gap-3 py-2 pointer-coarse:flex-wrap pointer-coarse:gap-y-1',
        RAIL_ROW_BODY,
      )}
    >
      <Link
        to={factoryAttentionTargetPath(factoryId, item.target)}
        aria-label={destinationLabel(item)}
        className={`absolute inset-0 rounded-lg ${focusRingInset}`}
      />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="sr-only">{item.read ? t('attention.read') : t('attention.unread')}</span>
        <Txt as="span" variant="column" tone="ink" className="truncate">
          {item.title}
        </Txt>
        <Txt as="span" variant="meta" tone="muted" className="truncate">
          {author ? (
            <Txt as="span" variant="meta" tone="muted">
              {author}{' '}
            </Txt>
          ) : null}
          {readableAttentionDetail(item.detail)}
        </Txt>
      </span>
      <span className={SWAP_SLOT}>
        <span className={cn('flex items-center gap-2', HIDDEN_ON_REVEAL)}>
          <Badge
            variant={KIND[item.kind].badge}
            emphasis={item.read ? 'subtle' : 'strong'}
            size="xs"
            icon={createElement(KIND[item.kind].glyph)}
          >
            {KIND_LABEL[item.kind]}
          </Badge>
          <Txt as="time" variant="meta" tone="muted" font="mono" dateTime={item.occurredAt}>
            {relativeTime(item.occurredAt)}
          </Txt>
        </span>
        <span className={SHOWN_ON_REVEAL}>
          <Button
            variant="ghost"
            size="icon-sm"
            tooltip={t('attention.askSupervisor')}
            aria-label={t('attention.askSupervisorAbout', { title: item.title })}
            onClick={() => void navigate(supervisorAskPath(factoryId, attentionPrompt(item)))}
          >
            <Brain aria-hidden />
          </Button>
          {onChooseRepository ? (
            <RowAction
              tooltip={t('attention.chooseRepository')}
              label={t('attention.chooseRepositoryFor', { title: item.title })}
              disabled={retrying}
              onClick={onChooseRepository}
            >
              <RotateCw aria-hidden />
            </RowAction>
          ) : null}
          {onRetry && !onChooseRepository ? (
            <RowAction
              tooltip={t('attention.retry')}
              label={
                retrying
                  ? t('attention.retryingTitle', { title: item.title })
                  : t('attention.retryTitle', { title: item.title })
              }
              disabled={retrying}
              onClick={onRetry}
            >
              {retrying ? <Spinner size="sm" aria-hidden className="size-3.5" /> : <RotateCw aria-hidden />}
            </RowAction>
          ) : null}
          {onApprove ? (
            <RowAction tooltip={t('attention.runIt')}
              label={t('attention.runTitle', { title: item.title })}
              disabled={settling} onClick={onApprove}>
              {settling ? <Spinner size="sm" aria-hidden className="size-3.5" /> : <Check aria-hidden />}
            </RowAction>
          ) : null}
          {onDismiss ? (
            <RowAction tooltip={t('attention.dismiss')}
              label={t('attention.dismissTitle', { title: item.title })}
              disabled={settling} onClick={onDismiss}>
              <X aria-hidden />
            </RowAction>
          ) : null}
          {!item.read ? (
            <RowAction
              tooltip={t('attention.markRead')}
              label={t('attention.markTitleRead', { title: item.title })}
              disabled={updatingReceipt}
              onClick={onRead}
            >
              <MailOpen aria-hidden />
            </RowAction>
          ) : null}
          {item.archived ? (
            <RowAction tooltip={t('attention.restore')}
              label={t('attention.restoreTitle', { title: item.title })}
              disabled={updatingReceipt} onClick={onRestore}>
              <ArchiveRestore aria-hidden />
            </RowAction>
          ) : (
            <RowAction
              tooltip={t('attention.archiveForMe')}
              label={t('attention.archiveTitle', { title: item.title })}
              disabled={updatingReceipt}
              onClick={onArchive}
            >
              <Archive aria-hidden />
            </RowAction>
          )}
        </span>
      </span>
    </div>
  );
}
