import { Button } from '@mastra/playground-ui/components/Button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@mastra/playground-ui/components/Collapsible';
import { toast } from '@mastra/playground-ui/components/Toaster';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useBoardCatalog } from '../../../../hooks/useBoardCatalog';
import { useClickUpSettingsQuery } from '../../../../hooks/useClickUp';
import { useIntakeBindingsQuery, useSaveIntakeBindingMutation } from '../../../../hooks/useIntakeConfig';
import { ClickUpStatusTable } from './ClickUpStatusRules';
import { BoardPicker, FactorySelect } from './RoutingSelects';

const INTEGRATION_ID = 'clickup';

/**
 * One connected ClickUp List: the Factory its tasks go to, the board for tasks no intake route
 * places, and what each ClickUp status does. Tags pick a board through the Factory's intake routes.
 * Collapsed it shows only the List and where it is routed, so a long list of Lists stays scannable.
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
  const settings = useClickUpSettingsQuery(true);
  const saveBinding = useSaveIntakeBindingMutation();

  const binding = (bindings.data ?? []).find(
    candidate => candidate.integrationId === INTEGRATION_ID && candidate.sourceId === listId,
  );
  const factory = factories.find(candidate => candidate.id === binding?.factoryProjectId);
  const board = binding?.board ?? null;
  const catalog = useBoardCatalog(factory?.id);
  const boardTitle = catalog.data?.find(candidate => candidate.id === board)?.title ?? board;
  const mapped = Object.values(settings.data?.lists[listId]?.statuses ?? {}).filter(rule => rule.action !== 'ignore').length;
  const saving = saveBinding.isPending;

  const route = (factoryProjectId: string | null, nextBoard: string | null) =>
    saveBinding.mutate(
      { integrationId: INTEGRATION_ID, sourceId: listId, factoryProjectId, board: nextBoard },
      {
        onSuccess: () => toast.success(t('linearRouting.saved', { label: 'ClickUp' })),
        onError: err => toast.error(err instanceof Error ? err.message : t('linearRouting.saveFailed', { label: 'ClickUp' })),
      },
    );

  const summary = !factory
    ? t('intake.clickup.card.notRouted')
    : board === null
      ? t('intake.clickup.card.noBoard', { factory: factory.name })
      : t('intake.clickup.card.routedTo', { factory: factory.name, board: boardTitle });

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="border-border1 rounded-lg border">
      <CollapsibleTrigger className="flex w-full items-center gap-3 rounded-lg px-4 py-3 text-left">
        <ChevronRight aria-hidden className={`size-4 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
        <Txt as="span" variant="body" tone="ink" className="min-w-0 flex-1 truncate">
          {name}
        </Txt>
        <Txt as="span" variant="caption" tone="muted" className="shrink-0">
          {summary}
          {factory ? ` · ${t('intake.clickup.card.mapped', { count: mapped })}` : ''}
        </Txt>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="border-border1 flex flex-col gap-5 border-t px-4 py-4">
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
                onChange={next => route(next, next === factory?.id ? board : null)}
              />
              {factory && (
                <BoardPicker
                  name={name}
                  factoryProjectId={factory.id}
                  board={board}
                  disabled={saving || busy}
                  onChange={next => route(factory.id, next)}
                />
              )}
            </div>
            <Txt as="p" variant="caption" tone="muted">
              {!factory ? t('intake.clickup.card.routingHint') : t('intake.clickup.card.boardHint')}
            </Txt>
          </section>

          <section aria-label={t('intake.clickup.card.statuses')} className="flex flex-col gap-2">
            <Txt as="h4" variant="meta" tone="muted">
              {t('intake.clickup.card.statuses')}
            </Txt>
            {factory && board === null ? (
              <Txt as="p" variant="caption" tone="muted">
                {t('intake.clickup.rules.needsBoard')}
              </Txt>
            ) : factory ? (
              <ClickUpStatusTable listId={listId} factoryProjectId={factory.id} board={board} />
            ) : (
              <Txt as="p" variant="caption" tone="muted">
                {t('intake.clickup.rules.needsFactory')}
              </Txt>
            )}
          </section>

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
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
