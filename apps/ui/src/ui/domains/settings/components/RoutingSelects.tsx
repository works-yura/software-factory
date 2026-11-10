import { Select, SelectContent, SelectItem, SelectTrigger } from '@mastra/playground-ui/components/Select';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { useTranslation } from 'react-i18next';

import { useBoardCatalog } from '../../../../hooks/useBoardCatalog';

const UNROUTED = '__unrouted__';
const NO_BOARD = '__no_board__';

/** Which Factory an intake source feeds. `null` leaves the source unrouted. */
export function FactorySelect({
  name,
  factories,
  value,
  disabled,
  onChange,
}: {
  name: string;
  factories: { id: string; name: string }[];
  value: string | null;
  disabled: boolean;
  onChange: (factoryProjectId: string | null) => void;
}) {
  const { t } = useTranslation('settings');
  const current = factories.find(factory => factory.id === value);
  return (
    <Select
      value={current?.id ?? UNROUTED}
      disabled={disabled || factories.length === 0}
      onValueChange={next => onChange(next === UNROUTED ? null : next)}
    >
      <SelectTrigger size="sm" aria-label={t('linearRouting.factoryFor', { name })} className="w-auto">
        <Txt as="span" variant="caption">
          {current?.name ?? t('linearRouting.notRouted')}
        </Txt>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={UNROUTED}>{t('linearRouting.notRouted')}</SelectItem>
        {factories.map(factory => (
          <SelectItem key={factory.id} value={factory.id}>
            {factory.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** The boards of a Factory as a select. */
export function BoardPicker({
  name,
  factoryProjectId,
  board,
  disabled,
  onChange,
}: {
  name: string;
  factoryProjectId: string;
  board: string | null;
  disabled: boolean;
  onChange: (board: string | null) => void;
}) {
  const { t } = useTranslation('settings');
  const catalog = useBoardCatalog(factoryProjectId);

  const boards = catalog.data ?? [];
  const current = boards.find(candidate => candidate.id === board);
  const label = current?.title ?? (board ? t('linearRouting.notInstalled', { board }) : t('linearRouting.chooseBoard'));
  // A List needs a board: its status rules move cards between that board's columns, so there is no "no board" choice.
  return (
    <Select value={current?.id ?? ''} disabled={disabled || catalog.isPending} onValueChange={value => onChange(value)}>
      <SelectTrigger size="sm" aria-label={t('linearRouting.boardFor', { name })} className="w-auto">
        <Txt as="span" variant="caption">
          {label}
        </Txt>
      </SelectTrigger>
      <SelectContent>
        {boards.map(candidate => (
          <SelectItem key={candidate.id} value={candidate.id}>
            {candidate.title}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** A board select over an already loaded list, e.g. the tag-route form. */
export function BoardSelect({
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
        <SelectItem value={NO_BOARD}>{t('linearRouting.noBoard')}</SelectItem>
        {boards.map(board => (
          <SelectItem key={board.id} value={board.id}>
            {board.title}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
