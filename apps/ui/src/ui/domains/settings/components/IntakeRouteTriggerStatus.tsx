import { Button } from '@mastra/playground-ui/components/Button';

import { Txt } from '@mastra/playground-ui/components/Txt';

import { useTranslation } from 'react-i18next';

import type { IntakeRouteInfo } from '../../../../api/types';

import { useIntakeRouteFiresQuery } from '../../../../hooks/useIntakeRoutes';

import { currentLanguage } from '../../../i18n';

/** A route «За розкладом»'s next fire, its last one, and its fire history on demand. */
export function TriggerStatus({
  route,
  factoryProjectId,
  open,
  onToggle,
}: {
  route: IntakeRouteInfo;
  factoryProjectId: string;
  open: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation('settings');
  const fires = useIntakeRouteFiresQuery(factoryProjectId, route.id, open);
  const triggered = route.triggered!;
  const format = new Intl.DateTimeFormat(currentLanguage(), { dateStyle: 'medium', timeStyle: 'short' });
  const outcome = (value: string) => t(`intakeTriggers.outcomes.${value}` as never);
  const next = !route.enabled
    ? t('intakeTriggers.paused')
    : triggered.nextFires?.[0]
      ? t('intakeTriggers.nextRun', { at: format.format(new Date(triggered.nextFires[0])) })
      : t('intakeTriggers.noClock');
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <Txt as="span" variant="caption" tone="muted">
          {next}
        </Txt>
        {triggered.lastFire?.firedAt && (
          <Txt as="span" variant="caption" tone="muted">
            {t('intakeTriggers.lastRun', {
              outcome: outcome(triggered.lastFire.outcome),
              at: format.format(new Date(triggered.lastFire.firedAt)),
            })}
          </Txt>
        )}
        <Button size="sm" variant="ghost" aria-expanded={open} onClick={onToggle}>
          {t('intakeTriggers.history')}
        </Button>
      </div>
      {open && (
        <ul aria-label={t('intakeTriggers.historyFor', { name: route.name })} className="flex flex-col gap-0.5">
          {fires.isPending && (
            <li>
              <Txt as="span" variant="caption" tone="muted">
                {t('intakeTriggers.loadingHistory')}
              </Txt>
            </li>
          )}
          {fires.data?.length === 0 && (
            <li>
              <Txt as="span" variant="caption" tone="muted">
                {t('intakeTriggers.noFires')}
              </Txt>
            </li>
          )}
          {fires.data?.map(fire => (
            <li key={fire.id}>
              <Txt as="span" variant="caption" tone="muted">
                {format.format(new Date(fire.firedAt))} · {outcome(fire.outcome)}
                {fire.reason ? ` · ${fire.reason}` : ''}
                {fire.workItemId ? ` · ${t('intakeTriggers.openCard')}` : ''}
              </Txt>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
