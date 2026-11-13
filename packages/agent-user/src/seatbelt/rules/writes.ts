import type { ProfileSection } from '../profile-section.ts';
import { subpath } from '../sbpl.ts';

/** Nothing is writable unless a later section allows it. */
export function denyAllWrites(): ProfileSection {
  return { title: 'Writes: nowhere, except what later sections allow.', rules: [{ action: 'deny', operations: ['file-write*'], filters: [subpath('/')] }] };
}

/** The temp folders every process needs and devices, which file modes guard. */
export const SYSTEM_WRITABLE = ['/tmp', '/private/tmp', '/var/folders', '/private/var/folders', '/dev'] as const;

/** The agent's own folders, then the system's shared ones. */
export function allowWrites(paths: readonly string[]): ProfileSection {
  return {
    title: 'Writes: the agent home, the card folders, temp folders, devices.',
    rules: [{ action: 'allow', operations: ['file-write*'], filters: [...new Set([...paths, ...SYSTEM_WRITABLE])].map(subpath) }],
  };
}
