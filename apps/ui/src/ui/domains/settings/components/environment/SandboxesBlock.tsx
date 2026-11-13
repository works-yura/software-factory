import { Badge } from '@mastra/playground-ui/components/Badge';
import type { BadgeVariant } from '@mastra/playground-ui/components/Badge';
import { Button } from '@mastra/playground-ui/components/Button';
import { Notice } from '@mastra/playground-ui/components/Notice';
import { Skeleton } from '@mastra/playground-ui/components/Skeleton';
import { toast } from '@mastra/playground-ui/components/Toaster';
import { Tooltip, TooltipContent, TooltipTrigger } from '@mastra/playground-ui/components/Tooltip';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { SettingsContainer } from '@mastra/playground-ui/new/settings';
import { useTranslation } from 'react-i18next';

import { useFactorySandboxesQuery, useSleepSandboxMutation } from '../../../../../hooks/useFactorySandboxes';
import { currentLanguage } from '../../../../i18n';
import type { FactorySandbox, FactorySandboxState } from '../../../workspaces/services/sandboxes';

const STATE_BADGE: Record<FactorySandboxState, BadgeVariant> = { active: 'success', idle: 'neutral', asleep: 'info' };

function formatSize(bytes: number): string {
  const units: Array<[string, number]> = [
    ['GB', 1024 ** 3],
    ['MB', 1024 ** 2],
  ];
  const format = new Intl.NumberFormat(currentLanguage(), { maximumFractionDigits: 1 });
  for (const [unit, size] of units) if (bytes >= size) return `${format.format(bytes / size)} ${unit}`;
  return `${format.format(Math.max(1, Math.round(bytes / 1024)))} KB`;
}

function formatTime(iso: string | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString(currentLanguage(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** The sandbox as the person knows it: the card's branch folder, or the session's own. */
function sandboxName(sandbox: FactorySandbox): string {
  return sandbox.kind === 'card' ? sandbox.key.split('/').slice(2).join('/') : sandbox.key;
}

/**
 * The Factory's local sandboxes: whose they are, their repositories, size on
 * disk, last activity and state, with «Save and stop» for one no agent works
 * in. Admins only; anyone else sees why the list is not there.
 */
export function SandboxesBlock({ factoryId }: { factoryId: string }) {
  const { t } = useTranslation('settings');
  const query = useFactorySandboxesQuery(factoryId);
  const sleep = useSleepSandboxMutation();

  if (query.isError) {
    const status = (query.error as { status?: number } | null)?.status;
    return (
      <Notice variant={status === 403 ? 'info' : 'destructive'}>
        {status === 403 ? t('environment.sandboxes.adminOnly') : t('environment.sandboxes.loadFailed')}
      </Notice>
    );
  }
  if (!query.data) return <Skeleton className="h-12 w-full" />;
  const { sandboxes } = query.data;
  if (sandboxes.length === 0) {
    return (
      <Txt as="p" variant="meta" tone="muted">
        {t('environment.sandboxes.empty')}
      </Txt>
    );
  }

  const saveAndStop = (sandbox: FactorySandbox) =>
    sleep.mutate(
      { factoryId, key: sandbox.key },
      {
        onSuccess: () => toast.success(t('environment.sandboxes.slept', { name: sandboxName(sandbox) })),
        onError: error => toast.error(error instanceof Error ? error.message : t('environment.sandboxes.sleepFailed')),
      },
    );

  return (
    <SettingsContainer>
      <ul className="divide-border flex flex-col divide-y" aria-label={t('environment.sandboxes.title')}>
        {sandboxes.map(sandbox => {
          const busy = sleep.isPending && sleep.variables?.key === sandbox.key;
          const action =
            sandbox.state === 'asleep' ? null : (
              <Button
                size="sm"
                variant="default"
                disabled={sandbox.state === 'active' || busy}
                onClick={() => saveAndStop(sandbox)}
              >
                {busy ? t('environment.sandboxes.sleeping') : t('environment.sandboxes.saveAndStop')}
              </Button>
            );
          return (
            <li key={sandbox.key} className="flex flex-col gap-1 px-4 py-3" data-testid="sandbox-row">
              <div className="flex flex-wrap items-center gap-3">
                <Badge size="sm" variant={STATE_BADGE[sandbox.state]}>
                  {t(`environment.sandboxes.state.${sandbox.state}`)}
                </Badge>
                <Txt as="span" font="mono" variant="body-sm" className="min-w-0 truncate" title={sandbox.key}>
                  {sandboxName(sandbox)}
                </Txt>
                <Txt as="span" variant="meta" tone="muted">
                  {t(`environment.sandboxes.kind.${sandbox.kind}`)}
                </Txt>
                <div className="ml-auto">
                  {sandbox.state === 'active' ? (
                    <Tooltip>
                      <TooltipTrigger render={<span tabIndex={0}>{action}</span>} />
                      <TooltipContent>{t('environment.sandboxes.activeTooltip')}</TooltipContent>
                    </Tooltip>
                  ) : (
                    action
                  )}
                </div>
              </div>
              <Txt as="p" variant="meta" tone="muted">
                {[
                  sandbox.repos.length ? sandbox.repos.join(', ') : undefined,
                  sandbox.sizeBytes !== undefined ? formatSize(sandbox.sizeBytes) : undefined,
                  sandbox.state === 'asleep'
                    ? t('environment.sandboxes.asleepSince', {
                        time: formatTime(sandbox.sleptAt),
                        reason: t(`environment.sandboxes.reason.${sandbox.sleepReason ?? 'manual'}`),
                      })
                    : sandbox.lastActivityAt
                      ? t('environment.sandboxes.lastActivity', { time: formatTime(sandbox.lastActivityAt) })
                      : undefined,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </Txt>
              {sandbox.problems.map(problem => (
                <Notice key={problem.kind} variant={problem.kind === 'save-failed' ? 'destructive' : 'warning'}>
                  {t(`environment.sandboxes.problem.${problem.kind}`)}
                  <Txt as="span" font="mono" variant="meta" className="block whitespace-pre-wrap">
                    {problem.message}
                  </Txt>
                </Notice>
              ))}
            </li>
          );
        })}
      </ul>
    </SettingsContainer>
  );
}
