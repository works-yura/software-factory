import { Button } from '@mastra/playground-ui/components/Button';
import { toast } from '@mastra/playground-ui/components/Toaster';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useIntakeBindingsQuery, useSaveIntakeBindingMutation } from '../../../../hooks/useIntakeConfig';
import { useIntakeRoutesQuery } from '../../../../hooks/useIntakeRoutes';
import { routesForList } from '../services/intakeRouteConditions';
import { FactorySelect } from './RoutingSelects';
import { SourceItemCard } from './SourceItemCard';

const INTEGRATION_ID = 'clickup';

/**
 * One connected ClickUp List as a source: the Factory its tasks belong to, and the intake routes of
 * that Factory that name the List. Routes decide which of its tasks are imported, where they land
 * and how a status change moves the card; the List itself only says which Factory reads it.
 */
export function ClickUpListCard({
  listId,
  name,
  factories,
  busy,
  onDisconnect,
}: {
  listId: string;
  name: string;
  factories: { id: string; name: string }[];
  busy: boolean;
  onDisconnect: () => void;
}) {
  const { t } = useTranslation('settings');
  const [open, setOpen] = useState(false);
  const bindings = useIntakeBindingsQuery();
  const saveBinding = useSaveIntakeBindingMutation();

  const binding = (bindings.data ?? []).find(
    candidate => candidate.integrationId === INTEGRATION_ID && candidate.sourceId === listId,
  );
  const factory = factories.find(candidate => candidate.id === binding?.factoryProjectId);
  const routesQuery = useIntakeRoutesQuery(factory?.id);
  const routes = routesForList(routesQuery.data ?? [], listId);
  const saving = saveBinding.isPending;

  const route = (factoryProjectId: string | null) =>
    saveBinding.mutate(
      // The board is kept as it was: routes place the List's tasks now.
      { integrationId: INTEGRATION_ID, sourceId: listId, factoryProjectId, board: binding?.board ?? null },
      {
        onSuccess: () => toast.success(t('linearRouting.saved', { label: 'ClickUp' })),
        onError: err => toast.error(err instanceof Error ? err.message : t('linearRouting.saveFailed', { label: 'ClickUp' })),
      },
    );

  const summary = !factory
    ? t('intake.clickup.card.notRouted')
    : `${factory.name} · ${t('intake.clickup.card.routes', { count: routes.length })}`;

  return (
    <SourceItemCard title={name} open={open} onOpenChange={setOpen} summary={summary}>
      <section aria-label={t('intake.clickup.card.routing')} className="flex flex-col gap-2">
        <Txt as="h4" variant="meta" tone="muted">
          {t('intake.clickup.card.routing')}
        </Txt>
        <div className="flex flex-wrap items-center gap-2">
          <FactorySelect
            name={name}
            factories={factories}
            value={factory?.id ?? null}
            disabled={saving || busy}
            onChange={next => route(next)}
          />
        </div>
        <Txt as="p" variant="caption" tone="muted">
          {!factory ? t('intake.clickup.card.routingHint') : t('intake.clickup.card.routesHint')}
        </Txt>
      </section>

      {factory && (
        <section aria-label={t('intake.clickup.card.listRoutes')} className="flex flex-col gap-1">
          <Txt as="h4" variant="meta" tone="muted">
            {t('intake.clickup.card.listRoutes')}
          </Txt>
          {routes.length === 0 ? (
            <Txt as="p" variant="caption" tone="muted">
              {t('intake.clickup.card.noRoutes')}
            </Txt>
          ) : (
            <ul className="flex flex-col gap-1">
              {routes.map(listRoute => (
                <li key={listRoute.id}>
                  <Txt as="span" variant="body-sm" tone={listRoute.enabled ? 'ink' : 'muted'}>
                    {listRoute.name}
                  </Txt>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <div className="flex justify-end">
        <Button
          size="sm"
          variant="ghost"
          aria-label={t('intake.clickup.card.disconnectAria', { name })}
          disabled={busy}
          onClick={onDisconnect}
        >
          {t('intake.clickup.card.disconnect')}
        </Button>
      </div>
    </SourceItemCard>
  );
}
