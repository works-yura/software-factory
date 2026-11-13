import { pathLookups } from '../path-lookups.ts';
import type { ProfileSection } from '../profile-section.ts';
import { literal, subpath } from '../sbpl.ts';

/**
 * What the agent reads: its own folders in full, and only the metadata of each folder above them,
 * enough to resolve a path into them but not to list their neighbours (`ls /Volumes`, `ls /Users`).
 */
export function allowReads(paths: readonly string[]): ProfileSection {
  const unique = [...new Set(paths)];
  return {
    title: 'Reads: the agent home and card folders; only lookup of the folders above them.',
    rules: [
      { action: 'allow', operations: ['file-read-metadata'], filters: pathLookups(unique).map(literal) },
      { action: 'allow', operations: ['file-read*'], filters: unique.map(subpath) },
    ],
  };
}
