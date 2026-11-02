import { Badge } from '@mastra/playground-ui/components/Badge';
import type { BadgeVariant } from '@mastra/playground-ui/components/Badge';
import { Button } from '@mastra/playground-ui/components/Button';
import { ButtonsGroup } from '@mastra/playground-ui/components/ButtonsGroup';
import { EmptyState } from '@mastra/playground-ui/components/EmptyState';
import { Notice } from '@mastra/playground-ui/components/Notice';
import { ScrollArea } from '@mastra/playground-ui/components/ScrollArea';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@mastra/playground-ui/components/Select';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { cn } from '@mastra/playground-ui/utils/cn';
import {
  Brain,
  CircleCheck,
  CircleDashed,
  CirclePause,
  CircleSlash,
  CircleX,
  ListFilter,
  Repeat,
  type LucideIcon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router';

import { useFactoryDecisionAction, useFactoryDecisionHistory } from '../../hooks/useFactoryDecisions';
import { relativeTime } from '../../lib/date/relativeTime';
import { dayHeading, groupByDay } from '../domains/factory/activity';
import { PageLayout } from '@mastra/playground-ui/components/PageLayout';
import { useSidebarHeaderSlots } from '../domains/chat/components/useSidebarHeaderSlots';
import { useActiveFactory } from '../domains/workspaces/components/FactoryLayout';
import { LoadMoreSentinel } from '../domains/factory/components/LoadMoreSentinel';
import { supervisorAskPath, supervisorChatEnabled } from '../domains/supervisor/services/supervisor';
import { DayHeading, RailRow, RAIL_LIST, RAIL_MARK_TONE, RAIL_ROW_BODY } from '../domains/factory/components/Timeline';
import type { FactoryDecisionStatus, FactoryDecisionSummary } from '../domains/factory/services/decisions';
import { SkeletonRows } from '../ui/SkeletonRows';
import { translator } from '../i18n/t';

const tk = translator('onboarding');

type DecisionGroupKey = 'all' | 'active' | 'proposed' | 'failed' | 'succeeded';

const DECISION_GROUPS: ReadonlyArray<{
  key: DecisionGroupKey;
  icon: LucideIcon;
  statuses: FactoryDecisionStatus[] | undefined;
}> = [
  { key: 'all', icon: ListFilter, statuses: undefined },
  { key: 'active', icon: CircleDashed, statuses: ['pending', 'leased', 'retry'] },
  { key: 'proposed', icon: CirclePause, statuses: ['proposed'] },
  { key: 'failed', icon: CircleX, statuses: ['failed'] },
  { key: 'succeeded', icon: CircleCheck, statuses: ['succeeded'] },
];

const groupLabel = (key: DecisionGroupKey): string => tk(`rules.groups.${key}`);

const STATUS_STYLE: Record<FactoryDecisionStatus, { icon: LucideIcon; tone: BadgeVariant; live?: true }> = {
  pending: { icon: CircleDashed, tone: 'info' },
  proposed: { icon: CirclePause, tone: 'warning' },
  dismissed: { icon: CircleSlash, tone: 'neutral' },
  superseded: { icon: CircleSlash, tone: 'neutral' },
  leased: { icon: CircleDashed, tone: 'cyan', live: true },
  retry: { icon: CircleDashed, tone: 'orange', live: true },
  succeeded: { icon: CircleCheck, tone: 'success' },
  failed: { icon: CircleX, tone: 'destructive' },
};

const statusLabel = (status: FactoryDecisionStatus): string => tk(`rules.statuses.${status}`);

/** Rule decisions and their durable queued effects for the active Factory. */
export function RulesPage() {
  const factory = useActiveFactory();
  const slots = useSidebarHeaderSlots();
  return (
    <PageLayout variant="fit" {...slots}>
      <div className="flex min-h-0 flex-col p-4">
        <RulesContent factoryProjectId={factory.id} />
      </div>
    </PageLayout>
  );
}

function RulesContent({ factoryProjectId }: { factoryProjectId: string | undefined }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedGroup = searchParams.get('group');
  const decisionGroup = DECISION_GROUPS.find(entry => entry.key === requestedGroup)?.key ?? 'all';
  const decisionFilter = DECISION_GROUPS.find(entry => entry.key === decisionGroup);
  const decisionStatuses = decisionFilter?.statuses;
  const decisionsQuery = useFactoryDecisionHistory(factoryProjectId, decisionGroup, decisionStatuses);
  const retryDecision = useFactoryDecisionAction(factoryProjectId, 'retry');
  const approveDecision = useFactoryDecisionAction(factoryProjectId, 'approve');
  const dismissDecision = useFactoryDecisionAction(factoryProjectId, 'dismiss');
  const mutationError = [retryDecision, approveDecision, dismissDecision].find(mutation => mutation.isError)?.error;
  const { t } = useTranslation('onboarding');

  if (decisionsQuery.isError) {
    const message = decisionsQuery.error instanceof Error ? decisionsQuery.error.message : t('rules.loadFailed');
    return <Notice variant="destructive">{message}</Notice>;
  }

  const decisions = decisionsQuery.data?.pages.flatMap(page => page.decisions) ?? [];
  const nowMs = Date.now();
  const hasDecisionFilter = decisionGroup !== 'all';

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-2" aria-labelledby="rule-decisions-heading">
      <div className="flex flex-col gap-2 lg:flex-row lg:flex-wrap lg:items-center lg:justify-between">
        <Txt tone="ink" as="h2" variant="column" className="m-0" id="rule-decisions-heading">
          {t('rules.title')}
        </Txt>
        <div className="w-full lg:hidden">
          <Select
            value={decisionGroup}
            onValueChange={group => setSearchParams(group === 'all' ? {} : { group }, { replace: true })}
          >
            <SelectTrigger size="sm" aria-label={t('rules.filterLabel')} className="w-full">
              {groupLabel(decisionFilter?.key ?? 'all')}
            </SelectTrigger>
            <SelectContent>
              {DECISION_GROUPS.map(entry => (
                <SelectItem key={entry.key} value={entry.key}>
                  {groupLabel(entry.key)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <ButtonsGroup size="sm" className="hidden lg:flex" role="group" aria-label={t('rules.filterLabel')}>
          {DECISION_GROUPS.map(entry => {
            const Icon = entry.icon;
            return (
              <Button
                key={entry.key}
                variant={decisionGroup === entry.key ? 'primary' : 'default'}
                aria-pressed={decisionGroup === entry.key}
                onClick={() => setSearchParams(entry.key === 'all' ? {} : { group: entry.key }, { replace: true })}
              >
                <Icon aria-hidden />
                {groupLabel(entry.key)}
              </Button>
            );
          })}
        </ButtonsGroup>
      </div>

      {mutationError !== undefined && (
        <Notice variant="destructive">
          {mutationError instanceof Error ? mutationError.message : t('rules.actionFailed')}
        </Notice>
      )}

      {decisionsQuery.isPending ? (
        <SkeletonRows label={t('rules.loading')} rows={4} rowClassName="h-16 w-full" />
      ) : decisions.length === 0 ? (
        <EmptyState
          className="min-h-0 flex-1"
          as="h3"
          iconSlot={<ListFilter aria-hidden />}
          titleSlot={hasDecisionFilter ? t('rules.empty.filteredTitle') : t('rules.empty.title')}
          descriptionSlot={
            hasDecisionFilter
              ? t('rules.empty.filteredDescription', {
                  filter: decisionFilter ? groupLabel(decisionFilter.key) : t('rules.empty.selected'),
                })
              : t('rules.empty.description')
          }
          actionSlot={
            hasDecisionFilter ? (
              <Button size="sm" onClick={() => setSearchParams({}, { replace: true })}>
                {t('rules.empty.showAll')}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <ScrollArea className="min-h-0 flex-1" revealScrollbarOnHover={false}>
          <div className="flex flex-col gap-8 pt-2 pr-1">
            {groupByDay(decisions.map(decision => ({ decision, at: Date.parse(decision.createdAt) }))).map(day => (
              <section key={day.dayMs} className="flex flex-col gap-5">
                <DayHeading>{dayHeading(day.dayMs, nowMs)}</DayHeading>
                <ul className={RAIL_LIST}>
                  {day.items.map(({ decision }, index) => {
                    const { icon: StatusIcon, tone } = STATUS_STYLE[decision.status];
                    return (
                      <RailRow
                        key={decision.id}
                        connected={index < day.items.length - 1}
                        mark={<StatusIcon size={14} className={RAIL_MARK_TONE[tone]} aria-hidden />}
                      >
                        <DecisionRow
                          factoryProjectId={factoryProjectId ?? ''}
                          decision={decision}
                          retrying={retryDecision.isPending && retryDecision.variables === decision.id}
                          approving={approveDecision.isPending && approveDecision.variables === decision.id}
                          dismissing={dismissDecision.isPending && dismissDecision.variables === decision.id}
                          onRetry={() => retryDecision.mutate(decision.id)}
                          onApprove={() => approveDecision.mutate(decision.id)}
                          onDismiss={() => dismissDecision.mutate(decision.id)}
                        />
                      </RailRow>
                    );
                  })}
                </ul>
              </section>
            ))}
            <LoadMoreSentinel
              hasNextPage={decisionsQuery.hasNextPage}
              isFetchingNextPage={decisionsQuery.isFetchingNextPage}
              onLoadMore={() => void decisionsQuery.fetchNextPage()}
              label={t('rules.loadMore')}
            />
          </div>
        </ScrollArea>
      )}
    </section>
  );
}

function DecisionRow({
  factoryProjectId,
  decision,
  retrying,
  approving,
  dismissing,
  onRetry,
  onApprove,
  onDismiss,
}: {
  factoryProjectId: string;
  decision: FactoryDecisionSummary;
  retrying: boolean;
  approving: boolean;
  dismissing: boolean;
  onRetry: () => void;
  onApprove: () => void;
  onDismiss: () => void;
}) {
  const navigate = useNavigate();
  const { t } = useTranslation('onboarding');
  const { tone, live } = STATUS_STYLE[decision.status];
  const label = statusLabel(decision.status);
  const progress = decision.completedAt
    ? t('rules.row.completed', { time: relativeTime(decision.completedAt) })
    : t('rules.row.updated', { time: relativeTime(decision.updatedAt) });

  return (
    <div className={cn('flex min-h-7 min-w-0 items-center gap-2 py-0.5', RAIL_ROW_BODY)}>
      <Txt tone="ink" as="span" variant="column" className="shrink-0 truncate">
        {decision.type}
      </Txt>
      <Badge size="xs" variant={tone} emphasis="subtle" {...(live ? { indicator: 'pulse' as const } : {})}>
        {label}
      </Badge>
      {decision.attempts > 1 ? (
        <Badge size="xs" variant="neutral" emphasis="subtle" icon={<Repeat aria-hidden />} title={t('rules.row.attempts')}>
          {decision.attempts}
        </Badge>
      ) : null}
      {decision.lastError ? (
        <Txt tone="muted" as="span" variant="meta" className="min-w-0 flex-1 truncate" title={decision.lastError}>
          {decision.lastError}
        </Txt>
      ) : null}
      <div className="ml-auto flex shrink-0 items-center gap-2 pl-2">
        {decision.status === 'failed' && supervisorChatEnabled() ? (
          <Button
            variant="ghost"
            size="icon-sm"
            tooltip={t('rules.row.askSupervisor')}
            aria-label={t('rules.row.askSupervisorAbout', { type: decision.type })}
            onClick={() =>
              void navigate(
                supervisorAskPath(
                  factoryProjectId,
                  `Explain why rule decision ${decision.id} failed and recommend the safest repair.`,
                ),
              )
            }
          >
            <Brain aria-hidden />
          </Button>
        ) : null}
        {decision.status === 'proposed' ? (
          <>
            <Button variant="ghost" size="sm" disabled={approving || dismissing} onClick={onDismiss}>
              {dismissing ? t('rules.row.dismissing') : t('rules.row.dismiss')}
            </Button>
            <Button size="sm" disabled={approving || dismissing} onClick={onApprove}>
              {approving ? t('rules.row.starting') : t('rules.row.run')}
            </Button>
          </>
        ) : decision.status === 'failed' && decision.canRetry ? (
          <Button size="sm" disabled={retrying} onClick={onRetry}>
            {retrying ? t('rules.row.retrying') : t('rules.row.retry')}
          </Button>
        ) : null}
        <Txt
          as="time"
          variant="meta"
          tone="muted"
          font="mono"
          dateTime={decision.createdAt}
          className={cn('shrink-0')}
          title={progress}
        >
          {relativeTime(decision.createdAt)}
        </Txt>
      </div>
    </div>
  );
}
