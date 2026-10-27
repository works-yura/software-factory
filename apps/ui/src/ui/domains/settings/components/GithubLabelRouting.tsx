import { Button } from '@mastra/playground-ui/components/Button';
import { Input } from '@mastra/playground-ui/components/Input';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@mastra/playground-ui/components/Select';
import { SettingsFieldsetRow, SettingsRow } from '@mastra/playground-ui/new/settings';
import { toast } from '@mastra/playground-ui/components/Toaster';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useBoardCatalog } from '../../../../hooks/useBoardCatalog';
import { useIntakeLabelRoutesQuery, useSaveIntakeLabelRouteMutation } from '../../../../hooks/useIntakeConfig';

const NO_BOARD = '__no_board__';

export function GithubLabelRouting({
  factoryProjectId,
  name,
  repositories,
}: {
  factoryProjectId: string;
  name: string;
  repositories: string[];
}) {
  const { t } = useTranslation('settings');
  const routesQuery = useIntakeLabelRoutesQuery(factoryProjectId);
  const catalog = useBoardCatalog(factoryProjectId);
  const save = useSaveIntakeLabelRouteMutation();
  const [draft, setDraft] = useState('');
  const [draftBoard, setDraftBoard] = useState<string | null>(null);

  const routes = (routesQuery.data ?? []).filter(route => route.integrationId === 'github');
  const boards = (catalog.data ?? []).filter(board => board.id !== 'work' && board.id !== 'review');
  const busy = save.isPending;

  const scope = t('labelRouting.scope', { repositories: repositories.join(', ') });

  const route = (label: string, board: string | null, onDone?: () => void) => {
    save.mutate(
      { factoryProjectId, integrationId: 'github', label, board },
      {
        onSuccess: () => {
          toast.success(t('labelRouting.saved'));
          onDone?.();
        },
        onError: err => toast.error(err instanceof Error ? err.message : t('labelRouting.saveFailed')),
      },
    );
  };

  if (routesQuery.isError) {
    return <SettingsRow label={name} description={t('labelRouting.routesUnavailable', { scope })} />;
  }

  if (boards.length === 0 && catalog.isSuccess && routes.length === 0) {
    return (
      <SettingsRow
        label={name}
        description={t('labelRouting.noBoards', { scope })}
      />
    );
  }

  const trimmed = draft.trim();
  const duplicate = routes.some(existing => existing.label === trimmed.toLowerCase());

  return (
    <div className="flex flex-col">
      <SettingsRow
        label={name}
        description={catalog.isError ? t('labelRouting.boardsUnavailable', { scope }) : scope}
      />
      {routes.map(existing => {
        const current = boards.find(board => board.id === existing.board);
        return (
          <SettingsRow
            key={existing.label}
            label={existing.label}
            description={
              current || catalog.isError
                ? undefined
                : t('labelRouting.boardNotInstalled', { board: existing.board })
            }
          >
            <div className="flex items-center gap-2">
              <BoardSelect
                ariaLabel={t('labelRouting.boardFor', { label: existing.label })}
                value={current?.id ?? null}
                placeholder={
                  current || catalog.isError ? (current?.title ?? existing.board) : t('labelRouting.notInstalled', { board: existing.board })
                }
                boards={boards}
                disabled={busy || !catalog.isSuccess}
                onChange={next => route(existing.label, next)}
              />
              <Button
                size="sm"
                variant="ghost"
                aria-label={t('labelRouting.removeRoute', { label: existing.label })}
                disabled={busy}
                onClick={() => route(existing.label, null)}
              >
                {t('labelRouting.remove')}
              </Button>
            </div>
          </SettingsRow>
        );
      })}
      <SettingsFieldsetRow
        label={t('labelRouting.addRoute')}
        description={duplicate ? t('labelRouting.duplicate') : undefined}
      >
        <div className="flex items-center gap-2">
          <Input
            size="sm"
            aria-label={t('labelRouting.labelFor', { name })}
            placeholder={t('labelRouting.labelPlaceholder')}
            value={draft}
            disabled={busy}
            onChange={event => setDraft(event.target.value)}
          />
          <BoardSelect
            ariaLabel={t('labelRouting.boardForNew', { name })}
            value={draftBoard}
            placeholder={t('labelRouting.chooseBoard')}
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
            {t('labelRouting.add')}
          </Button>
        </div>
      </SettingsFieldsetRow>
    </div>
  );
}

function BoardSelect({
  ariaLabel,
  value,
  placeholder,
  boards,
  disabled,
  onChange,
}: {
  ariaLabel: string;
  value: string | null;
  placeholder: string;
  boards: { id: string; title: string }[];
  disabled: boolean;
  onChange: (board: string | null) => void;
}) {
  const { t } = useTranslation('settings');
  const current = boards.find(board => board.id === value);
  return (
    <Select
      value={current?.id ?? NO_BOARD}
      disabled={disabled}
      onValueChange={next => onChange(next === NO_BOARD ? null : next)}
    >
      <SelectTrigger size="sm" aria-label={ariaLabel} className="w-auto">
        <Txt as="span" variant="caption">
          {current?.title ?? placeholder}
        </Txt>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NO_BOARD}>{t('labelRouting.noBoard')}</SelectItem>
        {boards.map(board => (
          <SelectItem key={board.id} value={board.id}>
            {board.title}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
