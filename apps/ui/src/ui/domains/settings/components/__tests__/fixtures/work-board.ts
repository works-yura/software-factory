import { workBoard } from '@factory/pipelines/work/board';
import { boardDefinitionOf, codeBehaviourOf } from '@factory/store/boards/stored-board';

import type { StoredBoardInfo, StoredBoardResponse } from '../../../../../../api/types';

/** The project's stored copy of the built-in Work board, as `GET …/boards/work` returns it. */
export function storedWorkBoard(board: Partial<StoredBoardInfo> = {}, canEdit = true): StoredBoardResponse {
  const { description, ...definition } = boardDefinitionOf(workBoard);
  return {
    board: {
      ...definition,
      description: description ?? null,
      revision: 1,
      source: 'builtin',
      editable: true,
      codeBehaviour: codeBehaviourOf(workBoard),
      problems: [],
      ...board,
    },
    canEdit,
  };
}
