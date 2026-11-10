import { Button } from '@mastra/playground-ui/components/Button';
import { Switch } from '@mastra/playground-ui/components/Switch';
import { toast } from '@mastra/playground-ui/components/Toaster';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import type { IntakeRuleFireInfo, IntakeRuleInfo } from '../../../../api/types';
import { useBoardCatalog } from '../../../../hooks/useBoardCatalog';
import {
  useCreateIntakeRuleMutation,
  useDeleteIntakeRuleMutation,
  useIntakeRuleFiresQuery,
  useIntakeRuleKindsQuery,
  useIntakeRulesQuery,
  useUpdateIntakeRuleMutation,
} from '../../../../hooks/useIntakeRules';
import type { IntakeRuleDraft } from '../../../../hooks/useIntakeRules';
import { currentLanguage } from '../../../i18n';
import { SkeletonRows } from '../../../ui/SkeletonRows';
import { boardPath } from '../../factory/boardCatalog';
import { SettingsSubsection } from '../components/SettingsSubsection';
import './builtinForms';
import { IntakeRuleEditor } from './IntakeRuleEditor';
import type { IntakeKindFormContext } from './formRegistry';

const failure = (error: unknown, fallback: string) => (error instanceof Error && error.message ? error.message : fallback);

function formatTime(at: string) {
  return new Intl.DateTimeFormat(currentLanguage(), { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(at));
}

function FireLine({ fire, factoryProjectId, boardKey }: { fire: IntakeRuleFireInfo; factoryProjectId: string; boardKey?: string }) {
  const { t } = useTranslation('settings');
  const outcome = t(`intakeRules.outcomes.${fire.outcome}`);
  return (
    <li className="flex flex-wrap items-center gap-2">
      <Txt as="span" variant="caption" tone="muted">
        {formatTime(fire.firedAt)}
      </Txt>
      <Txt as="span" variant="caption" tone={fire.outcome === 'failed' ? 'ink' : 'muted'}>
        {outcome}
      </Txt>
      {fire.workItemId && boardKey && (
        <Link
          className="text-caption underline"
          to={`${boardPath(factoryProjectId, boardKey)}?item=${encodeURIComponent(fire.workItemId)}`}
        >
          {t('intakeRules.openCard')}
        </Link>
      )}
      {fire.reason && (
        <Txt as="span" variant="caption" tone="muted">
          {fire.reason}
        </Txt>
      )}
    </li>
  );
}

function RuleHistory({ factoryProjectId, rule }: { factoryProjectId: string; rule: IntakeRuleInfo }) {
  const { t } = useTranslation('settings');
  const fires = useIntakeRuleFiresQuery(factoryProjectId, rule.id, true);
  const boardKey = typeof rule.action.config.boardKey === 'string' ? rule.action.config.boardKey : undefined;
  if (fires.isPending) return <SkeletonRows label={t('intakeRules.loadingHistory')} rows={1} />;
  const list = fires.data ?? [];
  if (list.length === 0) {
    return (
      <Txt as="p" variant="caption" tone="muted">
        {t('intakeRules.noFires')}
      </Txt>
    );
  }
  return (
    <ul aria-label={t('intakeRules.historyFor', { name: rule.name })} className="flex flex-col gap-1">
      {list.map(fire => (
        <FireLine key={fire.id} fire={fire} factoryProjectId={factoryProjectId} boardKey={boardKey} />
      ))}
    </ul>
  );
}

/**
 * Settings › Intake › Rules of one Factory: Factory's own intake source. Each rule is a trigger
 * (a schedule now) and an action (file a card on a board); the editor is built from the kinds the
 * server lists and the forms registered for them.
 */
export function IntakeRulesSection({ factoryProjectId, factoryName }: { factoryProjectId: string; factoryName: string }) {
  const { t } = useTranslation('settings');
  const rulesQuery = useIntakeRulesQuery(factoryProjectId);
  const kindsQuery = useIntakeRuleKindsQuery(factoryProjectId);
  const catalog = useBoardCatalog(factoryProjectId);
  const create = useCreateIntakeRuleMutation(factoryProjectId);
  const update = useUpdateIntakeRuleMutation(factoryProjectId);
  const remove = useDeleteIntakeRuleMutation(factoryProjectId);
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState<string | null>(null);

  const rules = rulesQuery.data ?? [];
  const busy = create.isPending || update.isPending || remove.isPending;
  const ready = kindsQuery.isSuccess && catalog.isSuccess;
  const context: IntakeKindFormContext = {
    factoryProjectId,
    boards: catalog.data ?? [],
    placeholders: kindsQuery.data?.placeholders ?? [],
  };

  const saveNew = (draft: IntakeRuleDraft) =>
    create.mutate(draft, {
      onSuccess: () => {
        toast.success(t('intakeRules.saved'));
        setEditing(null);
      },
      onError: error => toast.error(failure(error, t('intakeRules.saveFailed'))),
    });
  const saveEdit = (rule: IntakeRuleInfo, patch: Partial<IntakeRuleDraft>, onDone?: () => void) =>
    update.mutate(
      { rule, patch },
      {
        onSuccess: () => {
          toast.success(t('intakeRules.saved'));
          onDone?.();
        },
        onError: error => toast.error(failure(error, t('intakeRules.saveFailed'))),
      },
    );
  const deleteRule = (rule: IntakeRuleInfo) =>
    remove.mutate(rule, {
      onSuccess: () => {
        toast.success(t('intakeRules.deleted'));
        setConfirmingDelete(null);
      },
      onError: error => toast.error(failure(error, t('intakeRules.saveFailed'))),
    });

  return (
    <SettingsSubsection
      id="intake-rules"
      scope="factory"
      title={t('intakeRules.title')}
      description={t('intakeRules.description', { name: factoryName })}
      action={
        editing === null && rulesQuery.isSuccess ? (
          <Button size="sm" disabled={busy || !ready} onClick={() => setEditing('new')}>
            {t('intakeRules.add')}
          </Button>
        ) : undefined
      }
    >
      {rulesQuery.isPending ? (
        <SkeletonRows label={t('intakeRules.loading')} rows={2} />
      ) : rulesQuery.isError ? (
        <Txt tone="muted" as="p" variant="caption">
          {t('intakeRules.unavailable')}
        </Txt>
      ) : (
        <div className="flex flex-col gap-3">
          {rules.length === 0 && editing !== 'new' && (
            <Txt tone="muted" as="p" variant="caption">
              {t('intakeRules.empty')}
            </Txt>
          )}
          <ul className="flex flex-col gap-2" aria-label={t('intakeRules.listLabel')}>
            {rules.map(rule =>
              editing === rule.id && kindsQuery.data ? (
                <li key={rule.id}>
                  <IntakeRuleEditor
                    initial={rule}
                    kinds={kindsQuery.data}
                    context={context}
                    busy={busy}
                    onCancel={() => setEditing(null)}
                    onSave={draft => saveEdit(rule, draft, () => setEditing(null))}
                  />
                </li>
              ) : (
                <li key={rule.id} className="flex flex-col gap-1 rounded-md border border-border1 px-3 py-2" aria-label={rule.name}>
                  <div className="flex items-center justify-between gap-3">
                    <Txt as="span" variant="body" tone="ink" className="truncate">
                      {rule.name}
                    </Txt>
                    <div className="flex shrink-0 items-center gap-1">
                      <Switch
                        aria-label={t('intakeRules.enabledFor', { name: rule.name })}
                        checked={rule.enabled}
                        disabled={busy}
                        onCheckedChange={enabled => saveEdit(rule, { enabled })}
                      />
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-expanded={historyOpen === rule.id}
                        onClick={() => setHistoryOpen(current => (current === rule.id ? null : rule.id))}
                      >
                        {t('intakeRules.history')}
                      </Button>
                      <Button size="sm" variant="ghost" disabled={busy || editing !== null || !ready} onClick={() => setEditing(rule.id)}>
                        {t('intakeRules.edit')}
                      </Button>
                      {confirmingDelete === rule.id ? (
                        <Button size="sm" variant="destructive" disabled={busy} onClick={() => deleteRule(rule)}>
                          {t('intakeRules.confirmDelete')}
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={t('intakeRules.deleteRule', { name: rule.name })}
                          disabled={busy}
                          onClick={() => setConfirmingDelete(rule.id)}
                        >
                          {t('intakeRules.delete')}
                        </Button>
                      )}
                    </div>
                  </div>
                  <Txt as="p" variant="caption" tone="muted">
                    {t('intakeRules.summary', { trigger: rule.trigger.summary, action: rule.action.summary })}
                  </Txt>
                  <Txt as="p" variant="caption" tone="muted">
                    {rule.enabled && rule.nextFires[0]
                      ? t('intakeRules.nextRun', { at: formatTime(rule.nextFires[0]) })
                      : rule.enabled
                        ? t('intakeRules.noClock')
                        : t('intakeRules.paused')}
                    {rule.lastFire
                      ? ` · ${t('intakeRules.lastRun', {
                          at: formatTime(rule.lastFire.firedAt),
                          outcome: t(`intakeRules.outcomes.${rule.lastFire.outcome}`),
                        })}`
                      : ''}
                  </Txt>
                  {rule.problems.map(problem => (
                    <Txt key={problem} as="p" variant="caption" tone="muted" role="alert">
                      {t('intakeRules.problem', { problem })}
                    </Txt>
                  ))}
                  {historyOpen === rule.id && <RuleHistory factoryProjectId={factoryProjectId} rule={rule} />}
                </li>
              ),
            )}
          </ul>
          {editing === 'new' && kindsQuery.data && (
            <IntakeRuleEditor kinds={kindsQuery.data} context={context} busy={busy} onCancel={() => setEditing(null)} onSave={saveNew} />
          )}
        </div>
      )}
    </SettingsSubsection>
  );
}
