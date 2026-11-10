import { Txt } from '@mastra/playground-ui/components/Txt';
import type { ReactNode } from 'react';

import type { BoardLayout } from '../boardLayout';
import { translator } from '../../../i18n/t';
import { stageLabel } from '../stages';
import type { BoardStageId } from '../stages';

interface BoardColumnEmptyCopy {
  title: string;
  description: string;
}

const tk = translator('board');

function emptyCopy(key: string): BoardColumnEmptyCopy {
  return { title: tk(`emptyColumn.${key}.title`), description: tk(`emptyColumn.${key}.description`) };
}

function boardColumnEmptyCopy(
  stage: BoardStageId,
  hasIntakeSource: boolean,
  isInitialPhase: boolean,
): BoardColumnEmptyCopy {
  if (isInitialPhase) {
    if (!hasIntakeSource) return emptyCopy('noSources');
    return emptyCopy('intake');
  }
  switch (stage) {
    case 'triage':
      return emptyCopy('triage');
    case 'planning':
      return emptyCopy('planning');
    case 'execute':
      return emptyCopy('execute');
    case 'review':
      return emptyCopy('review');
    case 'pr-review':
      return emptyCopy('prReview');
    case 'done':
      return emptyCopy('done');
    case 'canceled':
      return emptyCopy('canceled');
    default:
      return {
        title: tk('emptyColumn.other.title', { stage: stageLabel(stage) }),
        description: tk('emptyColumn.other.description'),
      };
  }
}

function boardEmptyCopy(
  stage: BoardStageId,
  hasIntakeSource: boolean,
  filtersExcludeAll: boolean,
  alreadyMaterialized: number,
  isInitialPhase: boolean,
): BoardColumnEmptyCopy {
  if (filtersExcludeAll) {
    return {
      title: tk('emptyColumn.filteredWork'),
      description: tk('emptyColumn.filteredDescription'),
    };
  }
  const copy = boardColumnEmptyCopy(stage, hasIntakeSource, isInitialPhase);
  if (alreadyMaterialized <= 0) return copy;
  return {
    title: copy.title,
    description: tk('emptyColumn.alreadyMaterialized', { count: alreadyMaterialized }),
  };
}

export function BoardColumnEmptyState({
  stage,
  isInitialPhase,
  hasIntakeSource,
  filtersExcludeAll = false,
  alreadyMaterialized = 0,
  layout,
  actionSlot,
}: {
  stage: BoardStageId;
  isInitialPhase: boolean;
  hasIntakeSource: boolean;
  filtersExcludeAll?: boolean;
  /** Feed items withheld because their card sits on another board in this Factory. */
  alreadyMaterialized?: number;
  layout: BoardLayout;
  actionSlot?: ReactNode;
}) {
  const copy = boardEmptyCopy(stage, hasIntakeSource, filtersExcludeAll, alreadyMaterialized, isInitialPhase);
  if (layout === 'list') {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
        <Txt as="p" variant="meta" tone="muted" className="m-0">
          {copy.title}
          <Txt as="span" variant="meta" tone="faint">{` · ${copy.description}`}</Txt>
        </Txt>
        {actionSlot && <div className="flex flex-wrap gap-2">{actionSlot}</div>}
      </div>
    );
  }
  return (
    <div className="border-border rounded-card flex min-h-24 flex-col justify-center border border-dashed px-4 py-4">
      <Txt tone="muted" as="p" variant="column" className="m-0">
        {copy.title}
      </Txt>
      <Txt tone="muted" as="p" variant="meta" className="mt-1 mb-0 max-w-60">
        {copy.description}
      </Txt>
      {actionSlot && <div className="mt-3 flex flex-wrap gap-2">{actionSlot}</div>}
    </div>
  );
}
