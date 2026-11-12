import { Button } from '@mastra/playground-ui/components/Button';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams, useSearchParams } from 'react-router';

import { factoryConnections } from '../../connections/connections';
import { SettingsSubsection } from '../SettingsSubsection';
import { SkeletonRows } from '../../../../ui/SkeletonRows';
import { AddConnectionDialog } from './AddConnectionDialog';
import type { ConnectionTarget } from './ConnectSteps';
import { ConnectionActivity } from './ConnectionActivity';
import { ConnectionDetail } from './ConnectionDetail';
import { ConnectionList } from './ConnectionList';
import { useConnectionSources } from './useConnectionSources';

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Links from before the one list (`?tab=services&service=clickup`, `?tab=mcp`) land on the same thing now. */
const LEGACY_SERVICES = new Set(['google-cloud', 'clickup', 'github', 'gitlab']);

/**
 * Settings › Підключення: everything this Factory's agents connect to, in one list modelled on
 * Mastra Platform's Connect page — integration, account, capabilities, status, a «⋮» menu — with
 * «Додати підключення» (integrations and the organization's accounts in one searchable dialog, with each first-party integration's connect step) and
 * «Активність» below. MCP is a badge on a row, not a section. A row opens its own view
 * (`?connection=`), which keeps each integration's full settings.
 */
export function ConnectionsSection() {
  const { t } = useTranslation('settings');
  const { factoryId } = useParams<{ factoryId: string }>();
  const [params, setParams] = useSearchParams();
  const [adding, setAdding] = useState(false);
  const { sources, pending, errors } = useConnectionSources();

  const legacyService = params.get('service');
  useEffect(() => {
    if (!params.has('tab') && !legacyService) return;
    setParams(
      current => {
        const next = new URLSearchParams(current);
        next.delete('tab');
        next.delete('service');
        if (legacyService && LEGACY_SERVICES.has(legacyService)) next.set('connection', legacyService);
        return next;
      },
      { replace: true },
    );
  }, [params, legacyService, setParams]);

  if (!factoryId) return null;

  const open = params.get('connection');
  const go = (target: ConnectionTarget | null) =>
    setParams(current => {
      const next = new URLSearchParams(current);
      next.delete('connection');
      next.delete('account');
      if (target) {
        next.set('connection', target.connection);
        if (target.account) next.set('account', target.account);
      }
      return next;
    });

  const rows = factoryConnections(factoryId, sources);

  if (open) {
    if (pending) return <SkeletonRows label={t('connections.loading')} rows={3} />;
    const account = params.get('account');
    return (
      <ConnectionDetail
        key={open}
        id={open}
        {...(account ? { linkAccountId: account } : {})}
        factoryId={factoryId}
        rows={rows}
        sources={sources}
        onBack={() => go(null)}
      />
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-8">
      <SettingsSubsection
        title={t('connections.title')}
        description={t('connections.description')}
        scope="factory"
        action={
          <Button size="sm" className="min-h-11 md:min-h-0" onClick={() => setAdding(true)}>
            <Plus aria-hidden className="size-4" />
            {t('connections.add')}
          </Button>
        }
      >
        {errors.map(failure => (
          <div key={failure.kind} className="flex flex-wrap items-center justify-between gap-2">
            <Txt as="p" variant="caption" className="text-destructive-foreground">
              {t(`connections.kinds.${failure.kind}`)}: {errorMessage(failure.error)}
            </Txt>
            <Button size="sm" variant="ghost" onClick={failure.retry}>
              {t('intake.retry')}
            </Button>
          </div>
        ))}
        {pending ? (
          <SkeletonRows label={t('connections.loading')} rows={3} />
        ) : rows.length === 0 ? (
          <Txt as="p" variant="caption" tone="muted">
            {t('connections.empty')}
          </Txt>
        ) : (
          <ConnectionList
            rows={rows}
            factoryId={factoryId}
            sources={sources}
            canEditMcp={sources.mcp?.canEdit ?? false}
            onOpen={id => go({ connection: id })}
          />
        )}
      </SettingsSubsection>
      <ConnectionActivity factoryId={factoryId} />
      <AddConnectionDialog
        open={adding}
        factoryId={factoryId}
        sources={sources}
        onClose={() => setAdding(false)}
        onPick={target => {
          setAdding(false);
          go(target);
        }}
      />
    </div>
  );
}
