import { Button } from '@mastra/playground-ui/components/Button';
import { Plus } from 'lucide-react';

import type { BoardStageId } from '../stages';
import { translator } from '../../../i18n/t';

const tk = translator('board');

export function BoardStageCreateButton({
  stage,
  expanded,
  triggerRef,
  onOpen,
}: {
  stage: { id: BoardStageId; label: string };
  expanded: boolean;
  triggerRef: (element: HTMLButtonElement | null) => void;
  onOpen: () => void;
}) {
  return (
    <Button
      ref={triggerRef}
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label={tk('column.create', { stage: stage.label })}
      title={tk('column.create', { stage: stage.label })}
      aria-expanded={expanded}
      aria-controls={`new-work-item-${stage.id}`}
      onClick={onOpen}
    >
      <Plus size={13} aria-hidden />
    </Button>
  );
}
