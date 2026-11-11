// Plain-Node replacements for what t3code took from effect and @t3tools/shared: the process
// runner, child spawner, host process references, semaphores, timeouts and readiness polling.
// Everything the device server touches on the host goes through `DeviceRuntime`, so tests swap
// in fakes the way the originals provided Layers.
import * as NodeChildProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import * as NodeFSP from 'node:fs/promises';
import * as NodeNet from 'node:net';
import * as NodePath from 'node:path';
import * as NodeSea from 'node:sea';

// ---------------------------------------------------------------------------------------------
// Process runner (t3code apps/server/src/processRunner.ts)

export interface ProcessRunInput {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly stdin?: string | undefined;
  /** Default 60 s. */
  readonly timeoutMs?: number | undefined;
  readonly maxOutputBytes?: number | undefined;
  /** Timed-out results discard partial stdout/stderr. */
  readonly timeoutBehavior?: 'error' | 'timedOutResult' | undefined;
}

export interface ProcessRunOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
  readonly timedOut: boolean;
}

const formatProcessInvocation = (input: { readonly command: string; readonly cwd?: string | undefined }) =>
  input.cwd === undefined ? `'${input.command}'` : `'${input.command}' in '${input.cwd}'`;

export class ProcessSpawnError extends Error {
  readonly _tag = 'ProcessSpawnError';
  readonly command: string;
  readonly argumentCount: number;
  /** errno code such as ENOENT when the executable is missing. */
  readonly code: string | undefined;
  constructor(fields: { command: string; argumentCount: number; cwd?: string | undefined; cause: unknown }) {
    super(`Failed to spawn process ${formatProcessInvocation(fields)}`, { cause: fields.cause });
    this.command = fields.command;
    this.argumentCount = fields.argumentCount;
    const code = (fields.cause as NodeJS.ErrnoException | undefined)?.code;
    this.code = typeof code === 'string' ? code : undefined;
  }
}

export class ProcessReadError extends Error {
  readonly _tag = 'ProcessReadError';
  readonly command: string;
  readonly stream: 'stdout' | 'stderr' | 'exitCode';
  constructor(fields: { command: string; stream: 'stdout' | 'stderr' | 'exitCode'; cause: unknown }) {
    super(`Failed to read ${fields.stream} for process '${fields.command}'`, { cause: fields.cause });
    this.command = fields.command;
    this.stream = fields.stream;
  }
}

export class ProcessOutputLimitError extends Error {
  readonly _tag = 'ProcessOutputLimitError';
  readonly command: string;
  readonly stream: 'stdout' | 'stderr';
  readonly maxBytes: number;
  constructor(fields: { command: string; stream: 'stdout' | 'stderr'; maxBytes: number }) {
    super(`Process '${fields.command}' ${fields.stream} exceeded the ${fields.maxBytes} byte limit`);
    this.command = fields.command;
    this.stream = fields.stream;
    this.maxBytes = fields.maxBytes;
  }
}

export class ProcessTimeoutError extends Error {
  readonly _tag = 'ProcessTimeoutError';
  readonly command: string;
  readonly timeoutMs: number;
  constructor(fields: { command: string; timeoutMs: number }) {
    super(`Process '${fields.command}' timed out after ${fields.timeoutMs}ms`);
    this.command = fields.command;
    this.timeoutMs = fields.timeoutMs;
  }
}

export type ProcessRunError = ProcessSpawnError | ProcessReadError | ProcessOutputLimitError | ProcessTimeoutError;

export interface ProcessRunner {
  /** Rejects with a `ProcessRunError`; a non-zero exit is a result, not a rejection. */
  readonly run: (input: ProcessRunInput) => Promise<ProcessRunOutput>;
}

const DEFAULT_TIMEOUT_MS = 60_000;
// Keep SIGTERM-ignoring helpers from blocking timeouts or graceful shutdown.
const FORCE_KILL_AFTER_MS = 1_000;
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

const killTree = (child: NodeChildProcess.ChildProcess) => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const force = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }, FORCE_KILL_AFTER_MS);
  force.unref();
};

const needsShell = (command: string) => process.platform === 'win32' && /\.(cmd|bat)$/i.test(command);

export const nodeProcessRunner: ProcessRunner = {
  run: (input) =>
    new Promise<ProcessRunOutput>((resolve, reject) => {
      const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const maxOutputBytes = input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
      let child: NodeChildProcess.ChildProcess;
      try {
        child = NodeChildProcess.spawn(input.command, [...input.args], {
          ...(input.cwd ? { cwd: input.cwd } : {}),
          ...(input.env ? { env: input.env } : {}),
          shell: needsShell(input.command),
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } catch (cause) {
        reject(new ProcessSpawnError({ command: input.command, argumentCount: input.args.length, cwd: input.cwd, cause }));
        return;
      }
      let settled = false;
      const settle = (action: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        action();
      };
      const chunks = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
      const sizes = { stdout: 0, stderr: 0 };
      for (const stream of ['stdout', 'stderr'] as const) {
        child[stream]?.on('data', (chunk: Buffer) => {
          sizes[stream] += chunk.length;
          if (sizes[stream] > maxOutputBytes) {
            killTree(child);
            settle(() => reject(new ProcessOutputLimitError({ command: input.command, stream, maxBytes: maxOutputBytes })));
            return;
          }
          chunks[stream].push(chunk);
        });
        child[stream]?.on('error', (cause) =>
          settle(() => reject(new ProcessReadError({ command: input.command, stream, cause }))),
        );
      }
      const timer = setTimeout(() => {
        killTree(child);
        settle(() =>
          input.timeoutBehavior === 'timedOutResult'
            ? resolve({ stdout: '', stderr: '', code: null, timedOut: true })
            : reject(new ProcessTimeoutError({ command: input.command, timeoutMs })),
        );
      }, timeoutMs);
      child.once('error', (cause) =>
        settle(() =>
          reject(new ProcessSpawnError({ command: input.command, argumentCount: input.args.length, cwd: input.cwd, cause })),
        ),
      );
      child.once('close', (code) =>
        settle(() =>
          resolve({
            stdout: Buffer.concat(chunks.stdout).toString('utf8'),
            stderr: Buffer.concat(chunks.stderr).toString('utf8'),
            code,
            timedOut: false,
          }),
        ),
      );
      if (input.stdin !== undefined) {
        child.stdin?.on('error', () => undefined);
        child.stdin?.end(input.stdin);
      } else {
        child.stdin?.end();
      }
    }),
};

// ---------------------------------------------------------------------------------------------
// Long-lived children (effect ChildProcessSpawner)

export interface ChildHandle {
  readonly pid: number | undefined;
  readonly isRunning: () => boolean;
  /** Settles when the process exits; never rejects. */
  readonly exited: Promise<void>;
  /** SIGTERM, then SIGKILL a second later if it is still running. */
  readonly kill: () => void;
  /** Receives combined stdout and stderr, one line at a time. */
  readonly onOutputLine: (listener: (line: string) => void) => void;
}

export interface SpawnOptions {
  readonly cwd?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
}

/** Resolves once the process started; rejects when it could not be spawned. */
export type ProcessSpawner = (command: string, args: ReadonlyArray<string>, options: SpawnOptions) => Promise<ChildHandle>;

export const nodeProcessSpawner: ProcessSpawner = (command, args, options) =>
  new Promise<ChildHandle>((resolve, reject) => {
    const child = NodeChildProcess.spawn(command, [...args], {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.env ? { env: options.env } : {}),
      detached: false,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const exited = new Promise<void>((done) => child.once('exit', () => done()));
    const listeners: Array<(line: string) => void> = [];
    for (const stream of [child.stdout, child.stderr]) {
      let buffered = '';
      stream?.setEncoding('utf8');
      stream?.on('data', (text: string) => {
        buffered += text;
        const lines = buffered.split(/\r?\n/);
        buffered = lines.pop() ?? '';
        for (const line of lines) for (const listener of listeners) listener(line);
      });
      stream?.on('error', () => undefined);
    }
    child.once('error', (cause) => reject(new ProcessSpawnError({ command, argumentCount: args.length, cwd: options.cwd, cause })));
    child.once('spawn', () =>
      resolve({
        pid: child.pid,
        isRunning: () => child.exitCode === null && child.signalCode === null,
        exited,
        kill: () => killTree(child),
        onOutputLine: (listener) => void listeners.push(listener),
      }),
    );
  });

// ---------------------------------------------------------------------------------------------
// Host runtime bundle

export type DeviceFs = Pick<
  typeof NodeFSP,
  'access' | 'chmod' | 'mkdir' | 'mkdtemp' | 'readFile' | 'readdir' | 'realpath' | 'rename' | 'rm' | 'stat' | 'writeFile'
>;

export interface DeviceLogger {
  readonly debug: (message: string, fields?: Record<string, unknown>) => void;
  readonly info: (message: string, fields?: Record<string, unknown>) => void;
  readonly warn: (message: string, fields?: Record<string, unknown>) => void;
}

export const silentLogger: DeviceLogger = { debug: () => undefined, info: () => undefined, warn: () => undefined };

export const consoleLogger: DeviceLogger = {
  debug: () => undefined,
  info: (message, fields) => console.info(`[device] ${message}`, fields ?? ''),
  warn: (message, fields) => console.warn(`[device] ${message}`, fields ?? ''),
};

export interface DeviceRuntime {
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly uid: number | undefined;
  /** The running executable: Node itself, or a packaged binary when `isExecutable`. */
  readonly execPath: string;
  /** True for a packaged single-executable build, which cannot run Node scripts as itself. */
  readonly isExecutable: boolean;
  readonly fs: DeviceFs;
  readonly runner: ProcessRunner;
  readonly spawn: ProcessSpawner;
  readonly fetch: typeof fetch;
  readonly reserveLoopbackPort: () => Promise<number>;
  readonly now: () => number;
  readonly log: DeviceLogger;
}

export const reserveLoopbackPort = (host = '127.0.0.1') =>
  new Promise<number>((resolve, reject) => {
    const probe = NodeNet.createServer();
    probe.once('error', reject);
    probe.listen(0, host, () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => (port > 0 ? resolve(port) : reject(new Error('Failed to reserve loopback port'))));
    });
  });

export const nodeDeviceRuntime = (overrides: Partial<DeviceRuntime> = {}): DeviceRuntime => ({
  platform: process.platform,
  env: process.env,
  cwd: process.cwd(),
  uid: process.getuid?.(),
  execPath: process.execPath,
  isExecutable: NodeSea.isSea(),
  fs: NodeFSP,
  runner: nodeProcessRunner,
  spawn: nodeProcessSpawner,
  fetch: (input, init) => globalThis.fetch(input, init),
  reserveLoopbackPort: () => reserveLoopbackPort('127.0.0.1'),
  now: () => Date.now(),
  log: consoleLogger,
  ...overrides,
});

export const pathFor = (platform: NodeJS.Platform) => (platform === 'win32' ? NodePath.win32 : NodePath.posix);

export const fileExists = (fs: Pick<DeviceFs, 'access'>, file: string) =>
  fs.access(file).then(
    () => true,
    () => false,
  );

const errnoCode = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code;
export const isNotFound = (error: unknown) => errnoCode(error) === 'ENOENT';

// ---------------------------------------------------------------------------------------------
// Concurrency helpers (effect Semaphore, Effect.timeout, Effect.sleep)

export class Semaphore {
  #available: number;
  readonly #waiters: Array<() => void> = [];
  constructor(permits: number) {
    this.#available = permits;
  }
  async withPermit<T>(task: () => Promise<T> | T): Promise<T> {
    if (this.#available > 0) this.#available--;
    else await new Promise<void>((resolve) => this.#waiters.push(resolve));
    try {
      return await task();
    } finally {
      const next = this.#waiters.shift();
      if (next) next();
      else this.#available++;
    }
  }
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class TimeoutError extends Error {
  readonly _tag = 'TimeoutError';
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super(`Timed out after ${timeoutMs} ms`);
    this.timeoutMs = timeoutMs;
  }
}

/** Runs `task` with a signal that aborts after `ms`; rejects with `TimeoutError` when it does. */
export const withTimeout = <T>(ms: number, task: (signal: AbortSignal) => Promise<T>): Promise<T> => {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new TimeoutError(ms);
      controller.abort(error);
      reject(error);
    }, ms);
  });
  return Promise.race([task(controller.signal), timeout]).finally(() => clearTimeout(timer));
};

/** Like `withTimeout`, but resolves `undefined` instead of rejecting on timeout. */
export const timeoutOption = <T>(ms: number, task: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> =>
  withTimeout(ms, task).catch((error: unknown) => {
    if (error instanceof TimeoutError) return undefined;
    throw error;
  });

// ---------------------------------------------------------------------------------------------
// HTTP helpers

export class HttpStatusError extends Error {
  readonly _tag = 'StatusCodeError';
  readonly status: number;
  constructor(url: string, status: number) {
    super(`Request to ${url} failed with HTTP ${status}`);
    this.status = status;
  }
}

/** Polls `path` until it answers 2xx (shared/httpReadiness.ts). */
export const waitForHttpReady = async <E>(input: {
  readonly fetch: typeof fetch;
  readonly baseUrl: string;
  readonly path?: string;
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
  readonly probeTimeoutMs?: number;
  readonly makeError: (info: { readonly requestUrl: string; readonly attempt: number; readonly cause: unknown }) => E;
}): Promise<void> => {
  const timeoutMs = input.timeoutMs ?? 30_000;
  const intervalMs = input.intervalMs ?? 100;
  const probeTimeoutMs = input.probeTimeoutMs ?? 1_000;
  const requestUrl = new URL(input.path ?? '/', input.baseUrl).toString();
  const attempts = Math.max(0, Math.ceil(timeoutMs / intervalMs)) + 1;
  let cause: unknown = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await withTimeout(probeTimeoutMs, (signal) => input.fetch(requestUrl, { signal }));
      await response.arrayBuffer().catch(() => undefined);
      if (response.ok) return;
      cause = new HttpStatusError(requestUrl, response.status);
    } catch (error) {
      cause = error;
    }
    if (attempt < attempts) await sleep(intervalMs);
  }
  throw input.makeError({ requestUrl, attempt: attempts, cause });
};

// ---------------------------------------------------------------------------------------------
// Command resolution and the Node runtime (shared/shell.ts, shared/nodeRuntime.ts)

export type NodeRuntimeFeature = 'Local device support' | 'Device automation';

export const nodeRuntimeUnavailableMessage = (feature: NodeRuntimeFeature): string =>
  `${feature} requires Node.js. Install Node.js and make sure node is on PATH, then retry.`;

export class NodeRuntimeUnavailableError extends Error {
  readonly _tag = 'NodeRuntimeUnavailableError';
  readonly feature: NodeRuntimeFeature;
  constructor(fields: { feature: NodeRuntimeFeature; cause?: unknown }) {
    super(nodeRuntimeUnavailableMessage(fields.feature), fields.cause === undefined ? undefined : { cause: fields.cause });
    this.feature = fields.feature;
  }
}

export const resolveCommandPath = async (
  command: string,
  runtime: Pick<DeviceRuntime, 'platform' | 'fs'>,
  env: NodeJS.ProcessEnv,
): Promise<string | null> => {
  const windows = runtime.platform === 'win32';
  const path = pathFor(runtime.platform);
  const searchPath = env.PATH ?? env.Path ?? '';
  const extensions = windows
    ? path.extname(command)
      ? ['']
      : (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  if (command.includes('/') || (windows && command.includes('\\'))) {
    return (await isExecutableFile(runtime, command)) ? command : null;
  }
  for (const directory of searchPath.split(windows ? ';' : ':')) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = path.join(directory, command + extension);
      if (await isExecutableFile(runtime, candidate)) return candidate;
    }
  }
  return null;
};

const isExecutableFile = async (runtime: Pick<DeviceRuntime, 'platform' | 'fs'>, file: string) => {
  try {
    const info = await runtime.fs.stat(file);
    if (!info.isFile()) return false;
    if (runtime.platform === 'win32') return true;
    await runtime.fs.access(file, 1 /* X_OK */);
    return true;
  } catch {
    return false;
  }
};

export const isCommandAvailable = async (
  command: string,
  runtime: Pick<DeviceRuntime, 'platform' | 'fs' | 'env'>,
): Promise<boolean> => (await resolveCommandPath(command, runtime, runtime.env)) !== null;

/** The Node to run tool scripts with: this process, unless it is a packaged binary. */
export const resolveNodeExecutable = async (
  feature: NodeRuntimeFeature,
  runtime: Pick<DeviceRuntime, 'platform' | 'fs' | 'env' | 'execPath' | 'isExecutable'>,
  environment?: NodeJS.ProcessEnv,
): Promise<string> => {
  if (!runtime.isExecutable) return runtime.execPath;
  const env = environment ?? runtime.env;
  const path = pathFor(runtime.platform);
  const resolvedNodePath = await resolveCommandPath(
    runtime.platform === 'win32' ? 'node.exe' : 'node',
    runtime,
    runtime.platform === 'win32' ? { ...env, PATHEXT: '.EXE' } : env,
  );
  if (resolvedNodePath === null) throw new NodeRuntimeUnavailableError({ feature });
  const nodePath = path.resolve(resolvedNodePath);
  let resolvedPath: string;
  try {
    resolvedPath = await runtime.fs.realpath(nodePath);
  } catch (cause) {
    throw new NodeRuntimeUnavailableError({ feature, cause });
  }
  if (resolvedPath === runtime.execPath) throw new NodeRuntimeUnavailableError({ feature });
  const [hostInfo, nodeInfo] = await Promise.all([
    runtime.fs.stat(runtime.execPath).catch(() => null),
    runtime.fs.stat(nodePath).catch(() => null),
  ]);
  if (hostInfo && nodeInfo && hostInfo.dev === nodeInfo.dev && hostInfo.ino > 0 && hostInfo.ino === nodeInfo.ino) {
    throw new NodeRuntimeUnavailableError({ feature });
  }
  // Launchers such as Vite+ dispatch by argv[0]; keep the node name intact.
  return nodePath;
};

// ---------------------------------------------------------------------------------------------
// Files

/** Writes through a temporary file in the same directory, then renames it into place. */
export const writeFileAtomically = async (fs: DeviceFs, filePath: string, contents: string, mode?: number) => {
  const directory = NodePath.dirname(filePath);
  await fs.mkdir(directory, { recursive: true });
  const temporary = await fs.mkdtemp(NodePath.join(directory, `.${NodePath.basename(filePath)}.`));
  try {
    const tempPath = NodePath.join(temporary, 'contents.tmp');
    await fs.writeFile(tempPath, contents, mode === undefined ? undefined : { mode });
    await fs.rename(tempPath, filePath);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true }).catch(() => undefined);
  }
};

/** First 24 hex characters of the SHA-256 of `value`. */
export const shortHash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 24);
