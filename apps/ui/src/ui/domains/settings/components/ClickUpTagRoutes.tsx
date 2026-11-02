import { Button } from '@mastra/playground-ui/components/Button';
import { Input } from '@mastra/playground-ui/components/Input';
import { toast } from '@mastra/playground-ui/components/Toaster';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useBoardCatalog } from '../../../../hooks/useBoardCatalog';
import { useIntakeLabelRoutesQuery, useSaveIntakeLabelRouteMutation } from '../../../../hooks/useIntakeConfig';
import { BoardSelect } from './RoutingSelects';

const INTEGRATION_ID = 'clickup';

/**
 * Tag → board routes of one Factory: a task carrying the tag files onto that board instead of the
 * List's board. The routes belong to the Factory, so every List routed to it shows the same ones.
 */
export function ClickUpTagRoutes({ factoryProjectId, name }: { factoryProjectId: string; name: string }) {
  const { t } = useTranslation('settings');
  const routesQuery = useIntakeLabelRoutesQuery(factoryProjectId);
  const catalog = useBoardCatalog(factoryProjectId);
  const save = useSaveIntakeLabelRouteMutation();
  const [draft, setDraft] = useState('');
  const [draftBoard, setDraftBoard] = useState<string | null>(null);

  const routes = (routesQuery.data ?? []).filter(route => route.integrationId === INTEGRATION_ID);
  const boards = (catalog.data ?? []).filter(board => board.id !== 'review');
  const busy = save.isPending;
  const trimmed = draft.trim();
  const duplicate = routes.some(existing => existing.label === trimmed.toLowerCase());

  const route = (label: string, board: string | null, onDone?: () => void) =>
    save.mutate(
      { factoryProjectId, integrationId: INTEGRATION_ID, label, board },
      {
        onSuccess: () => {
          toast.success(t('tagRouting.saved'));
          onDone?.();
        },
        onError: err => toast.error(err instanceof Error ? err.message : t('tagRouting.saveFailed')),
      },
    );

  if (routesQuery.isError) {
    return (
      <Txt tone="muted" as="p" variant="caption">
        {t('tagRouting.unavailable')}
      </Txt>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <Txt tone="muted" as="p" variant="caption">
        {t('tagRouting.description')}
      </Txt>
      {routes.map(existing => (
        <div key={existing.label} className="flex items-center justify-between gap-3">
          <Txt as="span" variant="body">
            {existing.label}
          </Txt>
          <div className="flex items-center gap-2">
            <BoardSelect
              ariaLabel={t('tagRouting.boardFor', { label: existing.label })}
              value={boards.find(board => board.id === existing.board)?.id ?? null}
              placeholder={existing.board}
              boards={boards}
              disabled={busy || !catalog.isSuccess}
              onChange={next => route(existing.label, next)}
            />
            <Button
              size="sm"
              variant="ghost"
              aria-label={t('tagRouting.removeRoute', { label: existing.label })}
              disabled={busy}
              onClick={() => route(existing.label, null)}
            >
              {t('tagRouting.remove')}
            </Button>
          </div>
        </div>
      ))}
      <div className="flex items-center gap-2">
        <Input
          size="sm"
          aria-label={t('tagRouting.tagFor', { name })}
          placeholder={t('tagRouting.tagPlaceholder')}
          value={draft}
          disabled={busy}
          onChange={event => setDraft(event.target.value)}
        />
        <BoardSelect
          ariaLabel={t('tagRouting.boardForNew', { name })}
          value={draftBoard}
          placeholder={t('tagRouting.chooseBoard')}
          boards={boards}
          disabled={busy || !catalog.isSuccess}
          onChange={setDraftBoard}
        />
        <Button
          size="sm"
          disabled={busy || !trimmed || !draftBoard || duplicate}
          onClick={() =>
            route(trimmed, draftBoard, () => {
              setDraft('');
              setDraftBoard(null);
            })
          }
        >
          {t('tagRouting.add')}
        </Button>
      </div>
      {duplicate && (
        <Txt tone="muted" as="p" variant="caption">
          {t('tagRouting.duplicate')}
        </Txt>
      )}
    </div>
  );
}
