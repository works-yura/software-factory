import { createBoardRegistry } from './registry.ts';
import type { BoardRegistry } from './registry.ts';

/** The project a board lookup is for. */
export interface BoardScope {
  readonly orgId: string;
  readonly factoryProjectId: string;
}

/** Where a board in a project's catalog came from. */
export type BoardSourceKind = 'builtin' | 'app' | 'stored';

export interface StoredBoardDetails {
  source: BoardSourceKind;
  /** Whether the board can be edited: stored boards, the built-in Work board and app boards all can. */
  editable: boolean;
  problems: string[];
}

/** A project's boards: the code boards plus its stored boards, and what to report about each board. */
export interface ProjectBoards {
  readonly registry: BoardRegistry;
  readonly details: ReadonlyMap<string, StoredBoardDetails>;
  /** Problems with stored boards that are left out of the registry. */
  readonly problems: readonly string[];
}

/** Brands a per-project board source, so a fixed registry and a source are told apart. */
export const PROJECT_BOARD_SOURCE: unique symbol = Symbol('ProjectBoardSource');

/**
 * Serves each project its boards. `load` is the async entry point that brings a project's
 * boards up to date; `forProject` is the sync read for code that already loaded the project.
 */
export interface ProjectBoardSource {
  readonly [PROJECT_BOARD_SOURCE]: true;
  /** The code boards: built-in and app boards, served to every project as code built them. */
  readonly codeRegistry: BoardRegistry;
  load(scope: BoardScope): Promise<BoardRegistry>;
  forProject(scope: BoardScope): BoardRegistry;
  describe?(scope: BoardScope): Promise<ProjectBoards>;
}

/** Accepts either a fixed registry (tests, standalone services) or a per-project source. */
export function toBoardSource(boards: BoardRegistry | ProjectBoardSource | undefined): ProjectBoardSource {
  const source = boards ?? createBoardRegistry();
  if (isBoardSource(source)) return source;
  return {
    [PROJECT_BOARD_SOURCE]: true,
    codeRegistry: source,
    load: async () => source,
    forProject: () => source,
  };
}

function isBoardSource(boards: BoardRegistry | ProjectBoardSource): boards is ProjectBoardSource {
  return PROJECT_BOARD_SOURCE in boards;
}

