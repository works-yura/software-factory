import { isAbsolute, normalize } from 'node:path';

import { AgentUserConfigError } from './agent-user-config.ts';

/** A `:`-separated list of absolute paths, normalized, without trailing slashes; empty when unset. */
export function parsePathList(value: string | undefined, name: string): string[] {
  if (!value?.trim()) return [];
  return value
    .split(':')
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => {
      if (!isAbsolute(part)) throw new AgentUserConfigError(`${name}: ${JSON.stringify(part)} is not an absolute path.`);
      return normalize(part).replace(/\/+$/, '') || '/';
    });
}
