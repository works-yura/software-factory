import type { BoardDefinition } from './define-board.ts';

export type InstalledBoard = BoardDefinition<string, string>;
export interface BoardRegistry extends Iterable<[string, InstalledBoard]> {
  readonly size: number;
  get(id: string): InstalledBoard | undefined;
  has(id: string): boolean;
  keys(): MapIterator<string>;
  values(): MapIterator<InstalledBoard>;
  entries(): MapIterator<[string, InstalledBoard]>;
}

/**
 * Installs exactly the boards the caller passes. Work, Review, and Acceptance are
 * not built in: `@factory/pipelines` hands them in.
 */
export function createBoardRegistry(options: { boards?: readonly InstalledBoard[] } = {}): BoardRegistry {
  const registry = new Map<string, InstalledBoard>();

  for (const board of options.boards ?? []) {
    if (registry.has(board.id)) {
      throw new Error(`Factory: duplicate board id '${board.id}'.`);
    }
    registry.set(board.id, board);
  }

  return Object.freeze({
    size: registry.size,
    get: registry.get.bind(registry),
    has: registry.has.bind(registry),
    keys: registry.keys.bind(registry),
    values: registry.values.bind(registry),
    entries: registry.entries.bind(registry),
    [Symbol.iterator]: registry[Symbol.iterator].bind(registry),
  });
}
