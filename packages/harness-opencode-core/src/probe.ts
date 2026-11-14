// The catalog probe: an `opencode serve` in an empty folder of its own (its own state, no login),
// asked for its providers and stopped. What it lists is what a session's server would list.
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { HarnessCommand } from '@factory/harness/executable';

import type { OpenCodeProviderList } from './client.ts';
import { openCodeConfigContent } from './config.ts';
import { buildOpenCodeEnv, openCodeAuthContent, openCodeStateDirs } from './env.ts';
import { openCodeServerPassword, spawnOpenCodeServer, type OpenCodeSpawn } from './server.ts';

export interface OpenCodeProbeInput {
  command?: HarnessCommand;
  /** An empty folder the probe owns: its working directory and state root. */
  root: string;
  env?: Record<string, string | undefined>;
  spawn?: OpenCodeSpawn;
  sharedCacheDir?: string;
  /** An OpenCode account's key: the probe signs in with it, so its paid models list too. */
  apiKey?: string;
}

export async function probeOpenCode(input: OpenCodeProbeInput): Promise<{ providers: OpenCodeProviderList; version: string }> {
  const cwd = join(input.root, 'work');
  const dirs = openCodeStateDirs(join(input.root, 'state'), input.sharedCacheDir);
  await Promise.all([cwd, ...Object.values(dirs)].map(dir => mkdir(dir, { recursive: true, mode: 0o700 })));
  const server = await spawnOpenCodeServer({
    ...(input.command ? { command: input.command } : {}),
    cwd,
    env: buildOpenCodeEnv(input.env ?? process.env, {
      dirs,
      configContent: openCodeConfigContent({ policy: { edit: 'deny', bash: 'deny', web: 'deny' } }),
      password: openCodeServerPassword(),
      ...(input.apiKey ? { extra: { OPENCODE_AUTH_CONTENT: openCodeAuthContent(input.apiKey) } } : {}),
    }),
    ...(input.spawn ? { spawn: input.spawn } : {}),
  });
  try {
    return { providers: await server.client(cwd).providers(), version: server.version };
  } finally {
    server.terminate();
  }
}
