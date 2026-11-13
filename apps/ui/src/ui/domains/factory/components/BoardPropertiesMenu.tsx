import { DropdownMenu } from '@mastra/playground-ui/components/DropdownMenu';
import { ArrowUpDown, Funnel, LayersPlus } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { PropertiesMenu } from '../../../ui/PropertiesMenu';
import { boardFiltersActive, withBoardFilterValues } from '../boardFilters';
import { BOARD_SORT_LABELS, boardSortOptions, DEFAULT_BOARD_SORT } from '../boardSort';
import type { BoardSort } from '../boardSort';
import type { BoardView } from '../hooks/useBoardView';
import { BoardFilterSubmenu } from './BoardFilterSubmenu';
import { boardFilterSummary } from './boardFilterFields';
import type { BoardFilterField } from './boardFilterFields';

export function BoardPropertiesMenu({
  view,
  fields,
  currentUserId,
}: {
  view: BoardView;
  fields: readonly BoardFilterField[];
  currentUserId?: string;
}) {
  const { t } = useTranslation('board');
  const changes = [
    ...(view.sort === DEFAULT_BOARD_SORT ? [] : [t('properties.sortChange', { sort: BOARD_SORT_LABELS[view.sort] })]),
    ...fields
      .filter(field => view.filters[field.id].size > 0)
      .map(field =>
        t('properties.filterChange', {
          field: field.label,
          value: boardFilterSummary(field, [...view.filters[field.id]]),
        }),
      ),
  ];
  const canSaveAsView = !view.savedViews.applied && boardFiltersActive(view.filters);

  return (
    <PropertiesMenu
      label={t('properties.label')}
      variant="default"
      icon={<Funnel size={15} aria-hidden />}
      changedCount={changes.length}
      changes={changes}
      onReset={view.resetProperties}
    >
      <DropdownMenu.RadioSub
        label={t('properties.sort')}
        icon={<ArrowUpDown aria-hidden />}
        options={boardSortOptions(currentUserId)}
        value={view.sort}
        onValueChange={view.setSort}
      />
      {fields
        .filter(field => !field.hidden)
        .map(field => (
          <BoardFilterSubmenu
            key={field.id}
            field={field}
            selected={[...view.filters[field.id]]}
            onChange={values => view.setFilters(withBoardFilterValues(view.filters, field.id, values))}
          />
        ))}
      {canSaveAsView && (
        <>
          <DropdownMenu.Separator />
          <DropdownMenu.Item onClick={view.saveAsView}>
            <LayersPlus aria-hidden />
            <span>{t('properties.saveAsView')}</span>
          </DropdownMenu.Item>
        </>
      )}
    </PropertiesMenu>
  );
}
