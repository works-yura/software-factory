import { Select, SelectContent, SelectItem, SelectTrigger } from '@mastra/playground-ui/components/Select';
import { SettingsContainer, SettingsRow } from '@mastra/playground-ui/new/settings';
import { toast } from '@mastra/playground-ui/components/Toaster';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { useTranslation } from 'react-i18next';

import { useBoardCatalog } from '../../../../hooks/useBoardCatalog';
import {
  useClickUpListStatusesQuery,
  useClickUpSettingsQuery,
  useSaveClickUpListRulesMutation,
} from '../../../../hooks/useClickUp';
import { useIntakeBindingsQuery } from '../../../../hooks/useIntakeConfig';
import { statusKey } from '../../factory/services/clickup';
import type { ClickUpListRules, ClickUpStatusRule } from '../../factory/services/clickup';
import { SettingsSubsection } from './SettingsSubsection';

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
 * What the factory does with a task by its ClickUp status, per List: leave it, file it in a column
 * of the List's board, or close its card. Phases come from the board the List is routed to, so
 * custom boards and other projects' statuses work without code changes.
 */
export function ClickUpStatusRules({
  lists,
  enabled,
}: {
  lists: { id: string; name: string }[];
  enabled: boolean;
}) {
  const { t } = useTranslation('settings');
  const settings = useClickUpSettingsQuery(enabled);
  const bindings = useIntakeBindingsQuery(enabled);
  if (!enabled || lists.length === 0) return null;
  return (
    <SettingsSubsection scope="org" title={t('intake.clickup.rules.title')} description={t('intake.clickup.rules.description')}>
      {lists.map(list => {
        const binding = (bindings.data ?? []).find(
          candidate => candidate.integrationId === 'clickup' && candidate.sourceId === list.id,
        );
        return (
          <SettingsContainer key={list.id}>
            <ListRules
              list={list}
              rules={settings.data?.lists[list.id]}
              loading={settings.isPending || bindings.isPending}
              factoryProjectId={binding?.factoryProjectId}
              board={binding?.board ?? null}
            />
          </SettingsContainer>
        );
      })}
    </SettingsSubsection>
  );
}

function ListRules({
  list,
  rules,
  loading,
  factoryProjectId,
  board,
}: {
  list: { id: string; name: string };
  rules: ClickUpListRules | undefined;
  loading: boolean;
  factoryProjectId: string | undefined;
  board: string | null;
}) {
  const { t } = useTranslation('settings');
  const statuses = useClickUpListStatusesQuery(list.id);
  const catalog = useBoardCatalog(factoryProjectId);
  const save = useSaveClickUpListRulesMutation();

  if (!factoryProjectId || !board) {
    return <SettingsRow label={list.name} description={t('intake.clickup.rules.needsBoard')} />;
  }
  if (statuses.isError || catalog.isError) {
    return <SettingsRow label={list.name} description={t('intake.clickup.rules.unavailable')} />;
  }
  const installed = catalog.data?.find(candidate => candidate.id === board);
  if (catalog.isSuccess && !installed) {
    return <SettingsRow label={list.name} description={t('intake.clickup.rules.boardMissing', { board })} />;
  }
  const phases = (installed?.phases ?? []).filter(phase => phase.kind !== 'terminal');
  const busy = save.isPending || loading;

  const change = (statusName: string, value: string) => {
    const next: ClickUpListRules = { statuses: { ...(rules?.statuses ?? {}), [statusKey(statusName)]: decode(value) } };
    save.mutate(
      { listId: list.id, rules: next },
      {
        onSuccess: () => toast.success(t('intake.clickup.rules.saved')),
        onError: err => toast.error(err instanceof Error ? err.message : t('intake.clickup.rules.saveFailed')),
      },
    );
  };

  const label = (value: string): string =>
    value === IGNORE
      ? t('intake.clickup.rules.ignore')
      : value === CLOSE
        ? t('intake.clickup.rules.close')
        : (phases.find(phase => `${PHASE_PREFIX}${phase.id}` === value)?.title ?? value.slice(PHASE_PREFIX.length));

  return (
    <div className="flex flex-col">
      <SettingsRow
        label={list.name}
        description={t('intake.clickup.rules.listHint', { board: installed?.title ?? board })}
      />
      {statuses.isPending && (
        <Txt tone="muted" as="p" variant="caption" className="px-4 py-2">
          {t('intake.clickup.rules.loading')}
        </Txt>
      )}
      {(statuses.data ?? []).map(status => {
        const value = encode(rules?.statuses[statusKey(status.name)]);
        return (
          <SettingsRow key={status.name} label={status.name}>
            <Select value={value} disabled={busy || !catalog.isSuccess} onValueChange={next => change(status.name, next)}>
              <SelectTrigger size="sm" aria-label={t('intake.clickup.rules.statusAction', { status: status.name })} className="w-auto">
                <Txt as="span" variant="caption">
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
          </SettingsRow>
        );
      })}
    </div>
  );
}
