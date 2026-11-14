// Starts `opencode serve` for one run: on a free loopback port, behind a password of its own, in the
// session's checkout and state folders. It is ready once it says where it listens and its health
// route answers with a version the harness supports.
import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';

import { harnessCommandPath, reportHarnessSpawnFailure, type HarnessCommand } from '@factory/harness/executable';

import { OpenCodeClient } from './client.ts';
import { OpenCodeError } from './errors.ts';

/** The oldest CLI whose server routes (`/permission/{id}/reply`, `/question/{id}/reply`) the harness speaks. */
export const MINIMUM_OPENCODE_VERSION = '1.14.19';

export type OpenCodeSpawn = (command: string, args: string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;

export interface SpawnOpenCodeServerInput {
  /** The CLI: a path, or the server's resolver (`@factory/harness/executable`); `opencode` on PATH by default. */
  readonly command?: HarnessCommand;
  readonly cwd: string;
  /** The full environment (see `buildOpenCodeEnv`); it must carry `OPENCODE_SERVER_PASSWORD`. */
  readonly env: Record<string, string>;
  readonly spawn?: OpenCodeSpawn;
  /** How long the server gets to say it listens and answer its health route; 30 seconds by default. */
  readonly startTimeoutMs?: number;
  /** Picks the port; a free loopback port by default. */
  readonly port?: () => Promise<number>;
  readonly fetch?: typeof fetch;
}

export interface OpenCodeServerProcess {
  readonly url: string;
  readonly version: string;
  readonly pid: number | undefined;
  /** A client acting in `directory` (the session's checkout). */
  client(directory: string): OpenCodeClient;
  isAlive(): boolean;
  /** Ends the server and what it started (its process group): SIGTERM, then SIGKILL after a grace period. */
  terminate(): void;
  /** Resolves once the process exited, with the tail of what it wrote to stderr. */
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>;
}

const OUTPUT_TAIL_BYTES = 8 * 1024;
const FORCE_KILL_AFTER_MS = 2_000;
export const DEFAULT_OPENCODE_START_TIMEOUT_MS = 30_000;
const LISTENING_RE = /server listening on\s+(https?:\/\/\S+)/i;

/** A random password for one server: only the harness talks to it. */
export function openCodeServerPassword(): string {
  return randomBytes(24).toString('base64url');
}

/** A loopback port nothing listens on right now. (`--port=0` makes OpenCode take its default 4096.) */
export function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : undefined;
      server.close(() => (port ? resolve(port) : reject(new Error('No free port.'))));
    });
  });
}

/** `1.19.5` against `1.14.19`: negative when older. Pre-release suffixes are ignored. */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string) => value.split(/[.+-]/).slice(0, 3).map(part => Number.parseInt(part, 10) || 0);
  const [left, right] = [parse(a), parse(b)];
  for (let index = 0; index < 3; index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Starts `opencode serve` and waits until it answers; throws an {@link OpenCodeError} (`process`) when it does not. */
export async function spawnOpenCodeServer(input: SpawnOpenCodeServerInput): Promise<OpenCodeServerProcess> {
  // A resolver with no `opencode` throws its HarnessExecutableUnavailableError here, before any spawn.
  const command = harnessCommandPath(input.command, 'opencode');
  const password = input.env.OPENCODE_SERVER_PASSWORD;
  if (!password) throw new OpenCodeError('process', 'The OpenCode server needs a password of its own (OPENCODE_SERVER_PASSWORD).');
  const port = await (input.port ?? freeLoopbackPort)();
  const args = ['serve', '--hostname=127.0.0.1', `--port=${port}`];
  // The real CLI leads its own process group, so stopping it also stops the commands it runs; an
  // injected spawn gets a plain `kill`, since its pid is not ours to signal.
  const usesNodeSpawn = !input.spawn;
  const spawn = input.spawn ?? (nodeSpawn as OpenCodeSpawn);
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(command, args, { cwd: input.cwd, env: input.env as NodeJS.ProcessEnv, stdio: 'pipe', ...(usesNodeSpawn ? { detached: true } : {}) } as SpawnOptionsWithoutStdio);
  } catch (cause) {
    reportHarnessSpawnFailure(input.command, cause);
    throw new OpenCodeError('process', `Could not start \`${command} serve\`: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
  let output = '';
  let stderr = '';
  let announced: ((url: string) => void) | undefined;
  const listening = new Promise<string>(resolve => {
    announced = resolve;
  });
  const onOutput = (chunk: string, isErr: boolean) => {
    output = (output + chunk).slice(-OUTPUT_TAIL_BYTES);
    if (isErr) stderr = (stderr + chunk).slice(-OUTPUT_TAIL_BYTES);
    const match = LISTENING_RE.exec(output);
    if (match?.[1]) announced?.(match[1]);
  };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => onOutput(chunk, false));
  child.stderr.on('data', (chunk: string) => onOutput(chunk, true));
  let alive = true;
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>(resolve => {
    child.once('exit', (code, signal) => {
      alive = false;
      resolve({ code, signal, stderr: stderr.trim() });
    });
  });
  const failed = new Promise<never>((_, reject) => {
    child.once('error', cause => {
      alive = false;
      // Node reports a missing or non-executable file here (`spawn opencode ENOENT`): the resolver looks again next time.
      reportHarnessSpawnFailure(input.command, cause);
      reject(new OpenCodeError('process', `Could not start \`${command} serve\`: ${cause.message}`, { cause }));
    });
    void exited.then(({ code, signal }) =>
      reject(new OpenCodeError('process', `\`${command} serve\` exited (${signal ?? code}) before it was ready.${output.trim() ? `\n${output.trim().slice(-2000)}` : ''}`)),
    );
  });
  failed.catch(() => {});
  const signal = (sig: NodeJS.Signals) => {
    if (usesNodeSpawn && child.pid) {
      try {
        process.kill(-child.pid, sig);
        return;
      } catch {
        // The group is gone; fall back to the child itself.
      }
    }
    try {
      child.kill(sig);
    } catch {
      // Already exited.
    }
  };
  let stopping = false;
  const terminate = () => {
    if (stopping) return;
    stopping = true;
    if (!alive && !usesNodeSpawn) return;
    signal('SIGTERM');
    const killTimer = setTimeout(() => signal('SIGKILL'), FORCE_KILL_AFTER_MS);
    killTimer.unref?.();
    void exited.then(() => {
      if (!usesNodeSpawn) clearTimeout(killTimer);
    });
  };
  const timeoutMs = input.startTimeoutMs ?? DEFAULT_OPENCODE_START_TIMEOUT_MS;
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new OpenCodeError('timeout', `\`${command} serve\` did not answer within ${timeoutMs} ms.${output.trim() ? `\n${output.trim().slice(-2000)}` : ''}`)),
      timeoutMs,
    );
    timer.unref?.();
  });
  timedOut.catch(() => {});
  try {
    const url = await Promise.race([listening, failed, timedOut]);
    const probe = new OpenCodeClient({ baseUrl: url, password, directory: input.cwd, ...(input.fetch ? { fetch: input.fetch } : {}) });
    const health = await Promise.race([probe.health(), failed, timedOut]);
    if (!health?.healthy || typeof health.version !== 'string') throw new OpenCodeError('process', 'The OpenCode server answered its health check without a version.');
    if (compareVersions(health.version, MINIMUM_OPENCODE_VERSION) < 0) {
      throw new OpenCodeError('process', `OpenCode ${health.version} is too old for the Factory; install ${MINIMUM_OPENCODE_VERSION} or newer.`);
    }
    clearTimeout(timer);
    return {
      url,
      version: health.version,
      pid: child.pid,
      client: directory => new OpenCodeClient({ baseUrl: url, password, directory, ...(input.fetch ? { fetch: input.fetch } : {}) }),
      isAlive: () => alive,
      terminate,
      exited,
    };
  } catch (error) {
    clearTimeout(timer);
    terminate();
    throw error;
  }
}
