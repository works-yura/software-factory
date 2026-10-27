import { isAuditAction } from '@factory/store/audit/actions';
import type { AuditAction } from '@factory/store/audit/actions';
import { Avatar } from '@mastra/playground-ui/components/Avatar';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@mastra/playground-ui/components/HoverCard';
import { focusRing } from '@mastra/playground-ui/primitives/transitions';
import { cn } from '@mastra/playground-ui/utils/cn';
import { History } from 'lucide-react';

import { relativeTime } from '../../../../lib/date/relativeTime';
import { SYSTEM_ACTOR_NAME } from '../auditPresentation';
import type { AuditActorProfile, AuditEvent } from '../services/audit';
import { ASSIGNED_ACTION, CREATED_ACTION } from '../workItemActivity';
import type { WorkItemActivity as WorkItemActivityData } from '../workItemActivity';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { useTranslation } from 'react-i18next';

import { currentLanguage } from '../../../i18n';
import { translator } from '../../../i18n/t';

const ta = translator('activity');

function formatTimestamp(at: Date): string {
  return new Intl.DateTimeFormat(currentLanguage(), { dateStyle: 'medium', timeStyle: 'short' }).format(at);
}

const ACTION_LABELS: Partial<Record<AuditAction | typeof ASSIGNED_ACTION, () => string>> = {
  [ASSIGNED_ACTION]: () => ta('workItem.actions.assigned'),
  'factory.work_item.updated': () => ta('workItem.actions.updated'),
  'factory.work_item.stage_moved': () => ta('workItem.actions.moved'),
  'factory.work_item.deleted': () => ta('workItem.actions.removed'),
  'factory.run.started': () => ta('workItem.actions.runStarted'),
  'factory.run.ended': () => ta('workItem.actions.runEnded'),
  'factory.run.approved': () => ta('workItem.actions.suggestedRunStarted'),
  'factory.run.dismissed': () => ta('workItem.actions.suggestedRunDismissed'),
};

function knownActionLabel(action: string): string | undefined {
  if (isAuditAction(action) || action === ASSIGNED_ACTION) return ACTION_LABELS[action]?.();
  return undefined;
}

function actionLabel(action: string): string {
  return (
    knownActionLabel(action) ??
    action
      .replace(/^factory\./, '')
      .replaceAll('.', ' ')
      .replaceAll('_', ' ')
  );
}

function metadataString(event: AuditEvent, key: string): string | undefined {
  const value = event.metadata[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function eventActor(event: AuditEvent, actors: Record<string, AuditActorProfile>): AuditActorProfile | undefined {
  if (event.actorType === 'agent') {
    return { id: event.actorId, name: metadataString(event, 'agentName') ?? ta('workItem.factoryAgent') };
  }
  if (event.actorType === 'system') return { id: event.actorId, name: SYSTEM_ACTOR_NAME };
  return actors[event.actorId];
}

export function ActivityEvent({
  event,
  actors,
  className,
}: {
  event: AuditEvent;
  actors: Record<string, AuditActorProfile>;
  className?: string;
}) {
  const { t } = useTranslation('activity');
  const actor = eventActor(event, actors);
  if (!actor) return null;
  const modelId = event.actorType === 'agent' ? metadataString(event, 'modelId') : undefined;
  const isCreated = event.action === CREATED_ACTION;
  return (
    <div className={cn('flex items-start gap-2', className)}>
      <Avatar src={actor.avatarUrl} name={actor.name} size="sm" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <Txt as="span" variant="meta" tone="ink" className="truncate">
          {actor.name}
          {modelId ? (
            <Txt as="span" variant="meta" tone="muted">
              {' '}
              · {modelId}
            </Txt>
          ) : null}
        </Txt>
        <Txt as="span" variant="meta" tone="muted" className="flex items-baseline justify-between gap-3">
          <span className={cn('min-w-0', isCreated ? 'normal-case' : 'truncate first-letter:uppercase')}>
            {isCreated ? (
              <time dateTime={event.occurredAt}>
                {t('workItem.createdAt', { time: formatTimestamp(new Date(event.occurredAt)) })}
              </time>
            ) : (
              actionLabel(event.action)
            )}
          </span>
          {isCreated ? null : (
            <time className="shrink-0" dateTime={event.occurredAt}>
              {relativeTime(event.occurredAt)}
            </time>
          )}
        </Txt>
      </div>
    </div>
  );
}

export function WorkItemActivity({
  activity,
  actors,
  showName = true,
}: {
  activity: WorkItemActivityData;
  actors: Record<string, AuditActorProfile>;
  showName?: boolean;
}) {
  const { t } = useTranslation('activity');
  const worker = activity.lastWorker;
  const timeline = activity.events.slice(0, 8);
  const mergedActors = { ...actors, ...activity.extraActors };
  if (!worker) return null;

  return (
    <HoverCard>
      <HoverCardTrigger
        delay={150}
        closeDelay={100}
        render={
          <button
            type="button"
            draggable={false}
            aria-label={t('workItem.viewActivityBy', { name: worker.name })}
            onPointerDown={event => event.stopPropagation()}
            className={cn(
              'text-muted-foreground',
              `hover:text-foreground relative flex min-w-0 items-center gap-1.5 rounded-full ${focusRing}`,
            )}
          >
            {showName && (
              <Txt as="span" variant="meta" className="max-w-32 truncate">
                {worker.name}
              </Txt>
            )}
            <Avatar src={worker.avatarUrl} name={worker.name} size="sm" interactive />
          </button>
        }
      />
      <HoverCardContent
        side="right"
        align="start"
        sideOffset={8}
        collisionPadding={8}
        showArrow={false}
        className="w-80 max-w-[calc(100vw-2rem)]"
        aria-label={t('workItem.activityLabel')}
      >
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <History size={14} className="text-muted-foreground" aria-hidden />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <Txt as="span" variant="column" tone="ink">
                {t('workItem.activity')}
              </Txt>
              <Txt as="span" variant="meta" tone="muted" className="truncate">
                {t('workItem.lastWorkedOnBy', { name: worker.name })}
              </Txt>
            </div>
          </div>
          {timeline.length > 0 ? (
            <ol className="flex flex-col gap-2.5">
              {timeline.map(event => (
                <li key={event.id}>
                  <ActivityEvent event={event} actors={mergedActors} />
                </li>
              ))}
            </ol>
          ) : (
            <Txt as="span" variant="meta" tone="muted">
              {t('workItem.noActivity')}
            </Txt>
          )}
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}
