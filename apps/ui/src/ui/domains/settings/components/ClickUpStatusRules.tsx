import { Button } from '@mastra/playground-ui/components/Button';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@mastra/playground-ui/components/Select';
import { toast } from '@mastra/playground-ui/components/Toaster';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { useTranslation } from 'react-i18next';

import { useBoardCatalog } from '../../../../hooks/useBoardCatalog';
import {
  useClickUpListStatusesQuery,
  useClickUpSettingsQuery,
  useSaveClickUpListRulesMutation,
} from '../../../../hooks/useClickUp';
import { statusKey } from '../../factory/services/clickup';
import type { ClickUpListRules, ClickUpListStatus, ClickUpStatusRule } from '../../factory/services/clickup';

const IGNORE = 'ignore';
const CLOSE = 'close';
const PHASE_PREFIX = 'phase:';

const encode = (rule: ClickUpStatusRule | undefined): string =>
  !rule || rule.action === 'ignore' ? IGNORE : rule.action === 'close' ? CLOSE : `${PHASE_PREFIX}${rule.phase}`;

const decode = (value: string): ClickUpStatusRule =>
  value === CLOSE
    ? { action: 'close' }
    : value.startsWith(PHASE_PREFIX)
      ? { action: 'phase', phase: value.slice(PHASE_PREFIX.length) }
      : { action: 'ignore' };

/**
 * The rules most boards want, derived from ClickUp's own status types: an open status files the task in
 * the board's triage column (or its first working column when it has none), a finished one closes the card,
 * everything else is left alone. The user can still change any row.
 */
export function typicalRules(statuses: ClickUpListStatus[], phaseIds: string[]): ClickUpListRules {
  const entry = phaseIds.includes('triage') ? 'triage' : phaseIds[0];
  const rules: Record<string, ClickUpStatusRule> = {};
  for (const status of statuses) {
    if (status.type === 'closed' || status.type === 'done') rules[statusKey(status.name)] = { action: 'close' };
    else if (status.type === 'open' && entry) rules[statusKey(status.name)] = { action: 'phase', phase: entry };
  }
  return { statuses: rules };
}

/**
 * What the factory does with a task by its ClickUp status, for one List: leave it, file it in a column
 * of the List's board, or close its card. Phases come from the board the List is routed to, so custom
 * boards and other projects' statuses work without code changes.
 */
export function ClickUpStatusTable({
  listId,
  factoryProjectId,
  board,
}: {
  listId: string;
  factoryProjectId: string;
  board: string;
}) {
  const { t } = useTranslation('settings');
  const settings = useClickUpSettingsQuery(true);
  const statuses = useClickUpListStatusesQuery(listId);
  const catalog = useBoardCatalog(factoryProjectId);
  const save = useSaveClickUpListRulesMutation();
  const rules = settings.data?.lists[listId];

  if (statuses.isError || catalog.isError || settings.isError) {
    return (
      <Txt tone="muted" as="p" variant="caption">
        {t('intake.clickup.rules.unavailable')}
      </Txt>
    );
  }
  const installed = catalog.data?.find(candidate => candidate.id === board);
  if (catalog.isSuccess && !installed) {
    return (
      <Txt tone="muted" as="p" variant="caption">
        {t('intake.clickup.rules.boardMissing', { board })}
      </Txt>
    );
  }
  const phases = (installed?.phases ?? []).filter(phase => phase.kind !== 'terminal');
  const busy = save.isPending || settings.isPending;

  const persist = (next: ClickUpListRules) =>
    save.mutate(
      { listId, rules: next },
      {
        onSuccess: () => toast.success(t('intake.clickup.rules.saved')),
        onError: err => toast.error(err instanceof Error ? err.message : t('intake.clickup.rules.saveFailed')),
      },
    );
  const change = (statusName: string, value: string) =>
    persist({ statuses: { ...(rules?.statuses ?? {}), [statusKey(statusName)]: decode(value) } });

  const label = (value: string): string =>
    value === IGNORE
      ? t('intake.clickup.rules.ignore')
      : value === CLOSE
        ? t('intake.clickup.rules.close')
        : (phases.find(phase => `${PHASE_PREFIX}${phase.id}` === value)?.title ?? value.slice(PHASE_PREFIX.length));

  if (statuses.isPending) {
    return (
      <Txt tone="muted" as="p" variant="caption">
        {t('intake.clickup.rules.loading')}
      </Txt>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-start justify-between gap-3">
        <Txt tone="muted" as="p" variant="caption">
          {t('intake.clickup.rules.listHint', { board: installed?.title ?? board })}
        </Txt>
        <Button
          size="sm"
          variant="ghost"
          className="shrink-0"
          disabled={busy || !catalog.isSuccess}
          onClick={() =>
            persist(
              typicalRules(
                statuses.data ?? [],
                phases.map(phase => phase.id),
              ),
            )
          }
        >
          {t('intake.clickup.rules.typical')}
        </Button>
      </div>
      <div className="border-border1 flex flex-col divide-y rounded-md border">
        {(statuses.data ?? []).map(status => {
          const value = encode(rules?.statuses[statusKey(status.name)]);
          const active = value !== IGNORE;
          return (
            <div key={status.name} className="flex items-center justify-between gap-3 px-3 py-1.5">
              <Txt as="span" variant="body" tone={active ? 'ink' : 'muted'} className="truncate capitalize">
                {status.name}
              </Txt>
              <Select value={value} disabled={busy || !catalog.isSuccess} onValueChange={next => change(status.name, next)}>
                <SelectTrigger
                  size="sm"
                  aria-label={t('intake.clickup.rules.statusAction', { status: status.name })}
                  className="w-44 justify-between"
                >
                  <Txt as="span" variant="caption" tone={active ? 'ink' : 'muted'}>
                    {label(value)}
                  </Txt>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={IGNORE}>{t('intake.clickup.rules.ignore')}</SelectItem>
                  {phases.map(phase => (
                    <SelectItem key={phase.id} value={`${PHASE_PREFIX}${phase.id}`}>
                      {t('intake.clickup.rules.intoPhase', { phase: phase.title })}
                    </SelectItem>
                  ))}
                  <SelectItem value={CLOSE}>{t('intake.clickup.rules.close')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          );
        })}
      </div>
    </div>
  );
}
