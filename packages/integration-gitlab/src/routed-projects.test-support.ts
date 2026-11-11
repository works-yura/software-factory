import { DEFAULT_BOARD_ID } from '@factory/core';
import type { StoredBoardsStorage } from '@factory/store';

/** Subscribes a Factory project to the GitLab project at `path`, as a person's intake route would. */
export async function routeGitLabProject(
  boards: Pick<StoredBoardsStorage, 'createIntakeRoute'>,
  scope: { orgId: string; factoryProjectId: string },
  path: string,
): Promise<void> {
  await boards.createIntakeRoute(
    scope,
    {
      name: `GitLab: ${path}`,
      when: {
        operator: 'AND',
        conditions: [
          { field: 'source.integration', operator: 'equals', value: 'gitlab' },
          { field: 'source.repository', operator: 'equals', value: path },
        ],
      },
      target: { boardKey: DEFAULT_BOARD_ID, phaseKey: null },
    },
    'test',
  );
}
