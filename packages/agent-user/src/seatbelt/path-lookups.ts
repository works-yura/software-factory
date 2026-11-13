import { dirname } from 'node:path';

/**
 * Every folder above each path, outermost first, without `/` and without duplicates. Resolving a
 * path needs the metadata of each folder on the way; allowing only that lets the agent reach its
 * folders without listing what sits next to them.
 */
export function pathLookups(paths: readonly string[]): string[] {
  const result = new Set<string>();
  for (const path of paths) {
    const chain: string[] = [];
    for (let dir = dirname(path); dir !== '/' && dir !== '.'; dir = dirname(dir)) chain.unshift(dir);
    for (const dir of chain) result.add(dir);
  }
  return [...result];
}
