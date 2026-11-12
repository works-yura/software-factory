import { DropdownMenu } from '@mastra/playground-ui/components/DropdownMenu';
import { EmptyState } from '@mastra/playground-ui/components/EmptyState';
import { FilterBar, FilterBarChips, FilterBarInput } from '@mastra/playground-ui/components/FilterBar';
import type { FilterBarField, FilterBarItem, FilterBarOperator } from '@mastra/playground-ui/components/FilterBar';
import { Table } from '@mastra/playground-ui/components/Table';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { useIsMobile } from '@mastra/playground-ui/hooks/use-is-mobile';
import { CalendarDays, ChevronDown } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { useMcpActivity } from '../../../../../hooks/useMcpServers';
import { filterActivity } from '../../connections/connections';
import type { ActivityFilter } from '../../connections/connections';
import type { McpActivityCall } from '../../services/mcpServers';
import { TimeAgo } from './TimeAgo';

const RANGES = [1, 24, 168] as const;
type Range = (typeof RANGES)[number];

const OUTCOME_DOT = { ok: 'bg-green-500', error: 'bg-red-500' } as const;

function Outcome({ call }: { call: McpActivityCall }) {
  const { t } = useTranslation('settings');
  return (
    <span className="flex items-center gap-2">
      <span aria-hidden className={`inline-block size-1.5 shrink-0 rounded-full ${OUTCOME_DOT[call.outcome]}`} />
      <span>
        {call.outcome === 'ok' ? t('connections.activity.ok') : t('connections.activity.error')}
        {call.tried && <span className="text-muted-foreground"> · {t('connections.activity.tried')}</span>}
      </span>
    </span>
  );
}

function SessionLink({ factoryId, call }: { factoryId: string; call: McpActivityCall }) {
  const { t } = useTranslation('settings');
  if (!call.sessionId || call.tried) return null;
  return (
    <Link className="text-foreground underline underline-offset-2" to={`/factories/${factoryId}/workspaces/${call.sessionId}`}>
      {t('connections.activity.session')}
    </Link>
  );
}

/** The calls as the kit's inset table on wide screens; on phones one stacked entry per call. */
function Calls({ factoryId, calls, showConnection }: { factoryId: string; calls: McpActivityCall[]; showConnection: boolean }) {
  const { t } = useTranslation('settings');
  const isMobile = useIsMobile(640);
  const duration = (call: McpActivityCall) => (call.durationMs !== undefined ? t('mcpServers.calls.duration', { ms: call.durationMs }) : '—');

  if (isMobile) {
    return (
      <ul aria-label={t('connections.activity.listLabel')} className="bg-surface-panel shadow-raised flex flex-col rounded-xl p-1">
        {calls.map(call => (
          <li key={`${call.at}:${call.serverId}:${call.tool}`} className="text-body-sm flex flex-col gap-1 rounded-lg px-3 py-2">
            <span className="flex items-center justify-between gap-2">
              <span className="text-foreground truncate font-mono">{call.tool}</span>
              <TimeAgo value={call.at} className="text-muted-foreground shrink-0" />
            </span>
            {showConnection && <span className="text-muted-foreground truncate">{call.serverLabel}</span>}
            <span className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1">
              <Outcome call={call} />
              <span>{duration(call)}</span>
              <SessionLink factoryId={factoryId} call={call} />
            </span>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <Table variant="inset" aria-label={t('connections.activity.listLabel')}>
      <Table.Header>
        <Table.Row>
          <Table.Head>{t('connections.activity.columns.time')}</Table.Head>
          {showConnection && <Table.Head>{t('connections.activity.columns.connection')}</Table.Head>}
          <Table.Head className="w-full">{t('connections.activity.columns.tool')}</Table.Head>
          <Table.Head>{t('connections.activity.columns.outcome')}</Table.Head>
          <Table.Head align="end">{t('connections.activity.columns.duration')}</Table.Head>
          <Table.Head>
            <span className="sr-only">{t('connections.activity.columns.session')}</span>
          </Table.Head>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {calls.map(call => (
          <Table.Row key={`${call.at}:${call.serverId}:${call.tool}`}>
            <Table.Cell>
              <TimeAgo value={call.at} />
            </Table.Cell>
            {showConnection && <Table.Cell>{call.serverLabel}</Table.Cell>}
            <Table.Cell>
              <span className="font-mono">{call.tool}</span>
            </Table.Cell>
            <Table.Cell>
              <Outcome call={call} />
            </Table.Cell>
            <Table.Cell align="end">{duration(call)}</Table.Cell>
            <Table.Cell>
              <SessionLink factoryId={factoryId} call={call} />
            </Table.Cell>
          </Table.Row>
        ))}
      </Table.Body>
    </Table>
  );
}

/**
 * «Активність», as Mastra's Connect page: a period («Останні 24 години»), «Фільтр запитів» (the kit's
 * filter bar: connection, tool, outcome), then the calls — or an empty state. With `serverId` only
 * that connection's calls, without the connection column. Only MCP calls are in the audit trail;
 * `description` says so where the page has room.
 */
export function ConnectionActivity({
  factoryId,
  serverId,
  heading = true,
}: {
  factoryId: string;
  /** A connection's own page: only its calls. */
  serverId?: string;
  heading?: boolean;
}) {
  const { t } = useTranslation('settings');
  const [hours, setHours] = useState<Range>(24);
  const [filters, setFilters] = useState<FilterBarItem[]>([]);
  const activity = useMcpActivity(factoryId, hours);
  const all = (activity.data?.calls ?? []).filter(call => !serverId || call.serverId === serverId);
  const calls = filterActivity(all, filters as ActivityFilter[]);

  const unique = (values: string[]) => [...new Set(values)].sort().map(value => ({ value }));
  const fields: FilterBarField[] = [
    ...(serverId ? [] : [{ id: 'connection', label: t('connections.activity.fields.connection'), suggestions: unique(all.map(call => call.serverLabel)) }]),
    { id: 'tool', label: t('connections.activity.fields.tool'), suggestions: unique(all.map(call => call.tool)) },
    {
      id: 'outcome',
      label: t('connections.activity.fields.outcome'),
      operators: ['is', 'is-not'],
      strict: true,
      suggestions: [
        { value: 'ok', label: t('connections.activity.ok') },
        { value: 'error', label: t('connections.activity.error') },
      ],
    },
  ];
  const operators: FilterBarOperator[] = [
    { id: 'is', label: t('connections.activity.operators.is'), widensTo: 'in' },
    { id: 'is-not', label: t('connections.activity.operators.isNot') },
    { id: 'contains', label: t('connections.activity.operators.contains'), freeText: true },
    { id: 'in', label: t('connections.activity.operators.in'), arity: 'many' },
  ];

  return (
    <section aria-label={t('connections.activity.title')} className="flex min-w-0 flex-col gap-3">
      {heading && (
        <div className="flex flex-col gap-0.5">
          <h2 className="text-subheading text-foreground">{t('connections.activity.title')}</h2>
          <Txt as="p" variant="caption" tone="muted">
            {t('connections.activity.description')}
          </Txt>
        </div>
      )}
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <DropdownMenu>
          <DropdownMenu.Trigger type="button" variant="default" size="sm" aria-label={t('connections.activity.range.label')} className="shrink-0">
            <CalendarDays aria-hidden />
            {t(`connections.activity.range.h${hours}`)}
            <ChevronDown aria-hidden />
          </DropdownMenu.Trigger>
          <DropdownMenu.Content align="start" className="w-52">
            <DropdownMenu.RadioGroup value={String(hours)} onValueChange={value => setHours(Number(value) as Range)}>
              {RANGES.map(range => (
                <DropdownMenu.RadioItem key={range} value={String(range)}>
                  {t(`connections.activity.range.h${range}`)}
                </DropdownMenu.RadioItem>
              ))}
            </DropdownMenu.RadioGroup>
          </DropdownMenu.Content>
        </DropdownMenu>
        <FilterBar
          value={filters}
          onValueChange={setFilters}
          fields={fields}
          operators={operators}
          aria-label={t('connections.activity.filterLabel')}
          clearLabel={t('connections.activity.clear')}
          className="min-w-0 flex-1 basis-56"
        >
          <FilterBarChips />
          <FilterBarInput placeholder={t('connections.activity.filter')} aria-label={t('connections.activity.filter')} />
        </FilterBar>
      </div>
      {activity.isError ? (
        <Txt as="p" variant="caption" tone="muted">
          {t('connections.activity.unavailable')}
        </Txt>
      ) : !activity.data ? null : calls.length === 0 ? (
        <EmptyState
          iconSlot={null}
          titleSlot={all.length ? t('connections.activity.noMatch') : t('connections.activity.emptyTitle')}
          descriptionSlot={all.length ? undefined : t('connections.activity.emptyBody')}
          className="py-10"
        />
      ) : (
        <>
          <Calls factoryId={factoryId} calls={calls} showConnection={!serverId} />
          {activity.data.truncated && (
            <Txt as="p" variant="caption" tone="muted">
              {t('connections.activity.truncated')}
            </Txt>
          )}
        </>
      )}
    </section>
  );
}
