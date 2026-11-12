import { Button } from '@mastra/playground-ui/components/Button';
import { EmptyState } from '@mastra/playground-ui/components/EmptyState';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams, useSearchParams } from 'react-router';

import { factoryConnections } from '../../connections/connections';
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
const LEGACY_TABS = new Set(['services', 'mcp']);

/** The `?connection=` link of a connection's page. */
export const connectionHref = (id: string) => `?${new URLSearchParams({ connection: id }).toString()}`;

/**
 * Settings › Підключення, as Mastra's Connect page: the connections in the kit's table (the page
 * header carries «+ Додати підключення», which opens the dialog through `?add=1`), then «Активність».
 * A row links to its own page (`?connection=`), whose header and tabs `ConnectionDetail` and
 * `ConnectionsPageHeader` draw.
 */
export function ConnectionsSection() {
  const { t } = useTranslation('settings');
  const { factoryId } = useParams<{ factoryId: string }>();
  const [params, setParams] = useSearchParams();
  const { sources, pending, errors } = useConnectionSources();

  const legacyService = params.get('service');
  const legacyTab = params.get('tab');
  useEffect(() => {
    if (!(legacyTab && LEGACY_TABS.has(legacyTab)) && !legacyService) return;
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
  }, [legacyTab, legacyService, setParams]);

  if (!factoryId) return null;

  const open = params.get('connection');
  const adding = params.get('add') === '1';
  const go = (target: ConnectionTarget | null) =>
    setParams(current => {
      const next = new URLSearchParams(current);
      for (const key of ['connection', 'account', 'add', 'view']) next.delete(key);
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
      <section aria-labelledby="connections-list-heading" className="flex min-w-0 flex-col gap-3">
        <h2 id="connections-list-heading" className="text-subheading text-foreground">
          {t('connections.listHeading')}
        </h2>
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
          <EmptyState iconSlot={null} titleSlot={t('connections.empty')} className="py-10" />
        ) : (
          <ConnectionList
            rows={rows}
            factoryId={factoryId}
            sources={sources}
            canEditMcp={sources.mcp?.canEdit ?? false}
            hrefOf={connectionHref}
            onOpen={id => go({ connection: id })}
          />
        )}
      </section>
      <ConnectionActivity factoryId={factoryId} />
      <AddConnectionDialog
        open={adding}
        factoryId={factoryId}
        sources={sources}
        onClose={() =>
          setParams(current => {
            const next = new URLSearchParams(current);
            next.delete('add');
            return next;
          })
        }
        onPick={go}
      />
    </div>
  );
}
