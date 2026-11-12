import { Button } from '@mastra/playground-ui/components/Button';
import { EmptyState } from '@mastra/playground-ui/components/EmptyState';
import { Notice } from '@mastra/playground-ui/components/Notice';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams, useSearchParams } from 'react-router';

import { CONNECTIONS_CONTRACT_VERSION, contractMajor } from '@factory/contracts/connections';

import { SkeletonRows } from '../../../../ui/SkeletonRows';
import { AddConnectionDialog } from './AddConnectionDialog';
import type { Step } from './AddConnectionDialog';
import type { ConnectionTarget } from './ConnectSteps';
import { ConnectionActivity } from './ConnectionActivity';
import { ConnectionDetail } from './ConnectionDetail';
import { ConnectionList } from './ConnectionList';
import { useConnectionSources } from './useConnectionSources';

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Links from before the one list (`?tab=services&service=<id>`, `?tab=mcp`) land on the same thing
 * now: the service becomes `?connection=<id>`, which opens a connector's only connection, or the list.
 */
const LEGACY_TABS = new Set(['services', 'mcp']);

/** A connect step the dialog opens straight into (`&step=`): a connector's, or a connection's reconnect. */
const isStep = (value: string | null): value is Step => Boolean(value?.startsWith('connector:') || value?.startsWith('reconnect:'));

/**
 * Whether this page understands the server's connections contract: the same major. A server of an
 * older contract may leave fields out (its `contractVersion` may be missing too, read as 1).
 */
function speaksContract(version: string | undefined): boolean {
  return contractMajor(version ?? '1.0.0') === contractMajor(CONNECTIONS_CONTRACT_VERSION);
}

/** The `?connection=` link of a connection's page. */
export const connectionHref = (id: string) => `?${new URLSearchParams({ connection: id }).toString()}`;

/**
 * Settings › Підключення, as Mastra's Connect page: the connections in the kit's table (the page
 * header carries «+ Додати підключення», which opens the dialog through `?add=1`), then «Активність».
 * A row links to its own page (`?connection=`). Everything shown is what the server describes
 * (ADR-0035); the page knows no provider.
 */
export function ConnectionsSection() {
  const { t } = useTranslation('settings');
  const { factoryId } = useParams<{ factoryId: string }>();
  const [params, setParams] = useSearchParams();
  const { sources, pending, error } = useConnectionSources();

  const legacyService = params.get('service');
  const legacyTab = params.get('tab');
  useEffect(() => {
    if (!(legacyTab && LEGACY_TABS.has(legacyTab)) && !legacyService) return;
    setParams(
      current => {
        const next = new URLSearchParams(current);
        next.delete('tab');
        next.delete('service');
        if (legacyService) next.set('connection', legacyService);
        return next;
      },
      { replace: true },
    );
  }, [legacyTab, legacyService, setParams]);

  const open = params.get('connection');
  const views = sources.connections?.connections ?? [];
  const connectors = sources.connectors ?? [];
  const organizationWide = sources.connections?.copy.organizationWide ?? '';
  // `?connection=<connector>` (by its id or an older name) becomes its only connection, else the list.
  const linked =
    open !== null && !views.some(view => view.id === open)
      ? connectors.find(connector => connector.id === open || connector.aliases?.includes(open))
      : undefined;
  const ofConnector = linked ? views.filter(view => view.connector.id === linked.id) : [];
  const resolvedLink = linked && !pending ? (ofConnector.length === 1 ? ofConnector[0]!.id : '') : undefined;
  useEffect(() => {
    if (resolvedLink === undefined) return;
    setParams(
      current => {
        const next = new URLSearchParams(current);
        if (resolvedLink) next.set('connection', resolvedLink);
        else next.delete('connection');
        return next;
      },
      { replace: true },
    );
  }, [resolvedLink, setParams]);

  if (!factoryId) return null;

  const adding = params.get('add') === '1';
  const go = (target: ConnectionTarget | null) =>
    setParams(current => {
      const next = new URLSearchParams(current);
      for (const key of ['connection', 'add', 'step', 'view']) next.delete(key);
      if (target) next.set('connection', target.connection);
      return next;
    });

  if (open && !linked) {
    if (pending) return <SkeletonRows label={t('connections.loading')} rows={3} />;
    return (
      <ConnectionDetail
        key={open}
        id={open}
        factoryId={factoryId}
        views={views}
        connectors={connectors}
        organizationWide={organizationWide}
        onDone={() => go(null)}
      />
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-8">
      <section aria-labelledby="connections-list-heading" className="flex min-w-0 flex-col gap-3">
        <div className="flex flex-col gap-0.5">
          <h2 id="connections-list-heading" className="text-subheading text-foreground">
            {t('connections.listHeading')}
          </h2>
          <Txt as="p" variant="caption" tone="muted">
            {t('connections.organizationNote')}
          </Txt>
        </div>
        {error && (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Txt as="p" variant="caption" className="text-destructive-foreground">
              {t('connections.title')}: {errorMessage(error.error)}
            </Txt>
            <Button size="sm" variant="ghost" onClick={error.retry}>
              {t('intake.retry')}
            </Button>
          </div>
        )}
        {sources.connections && !speaksContract(sources.connections.contractVersion) && (
          <Notice variant="warning" title={t('connections.contractUpdate.title')} role="alert">
            <Notice.Message>{t('connections.contractUpdate.message', { server: sources.connections.contractVersion, client: CONNECTIONS_CONTRACT_VERSION })}</Notice.Message>
          </Notice>
        )}
        {(sources.connections?.failures ?? []).map(failure => (
          <Txt key={failure.connector.id} as="p" variant="caption" className="text-destructive-foreground">
            {failure.connector.name}: {failure.message}
          </Txt>
        ))}
        {pending ? (
          <SkeletonRows label={t('connections.loading')} rows={3} />
        ) : views.length === 0 ? (
          <EmptyState iconSlot={null} titleSlot={t('connections.empty')} className="py-10" />
        ) : (
          <ConnectionList
            views={views}
            organizationWide={organizationWide}
            hrefOf={connectionHref}
            onOpen={id => go({ connection: id })}
            onReconnect={step =>
              setParams(current => {
                const next = new URLSearchParams(current);
                next.set('add', '1');
                next.set('step', step);
                return next;
              })
            }
          />
        )}
      </section>
      <ConnectionActivity factoryId={factoryId} />
      <AddConnectionDialog
        open={adding}
        {...(isStep(params.get('step')) ? { initialStep: params.get('step') as Step } : {})}
        sources={sources}
        onClose={() =>
          setParams(current => {
            const next = new URLSearchParams(current);
            next.delete('add');
            next.delete('step');
            return next;
          })
        }
        onPick={go}
      />
    </div>
  );
}
