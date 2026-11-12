// The executable a CLI-backed harness (Claude Code, Codex) spawns, resolved once for the whole
// server instead of trusting the server's PATH: a launchd/systemd service starts with a bare PATH
// (`/usr/bin:/bin:/usr/sbin:/sbin`), and a CLI installed into `~/.local/bin` or nvm's node is then
// "spawn claude ENOENT" on every run. Node-only (`node:fs`, `node:child_process`): import it from
// `@factory/harness/executable`, never from the browser.
//
// Where it looks, in order (ADR-0038):
//   1. the command the deployment configured (`FACTORY_CLAUDE_CODE_COMMAND`, …): a path is taken
//      as is, and only that path (a typo must not silently run another binary); a bare name is
//      looked up like the default one;
//   2. the server's PATH;
//   3. the places the CLIs install into on a developer's machine or a Mac mini
//      ({@link wellKnownExecutableDirs}).
//
// A found executable is kept: spawning it costs no lookup. One that is missing is looked up again
// the next time it is asked for, so installing the CLI after the server started makes the harness
// available without a restart. A spawn that fails for good on the kept path (it was removed)
// drops it, and the next spawn looks again.
import { execFile } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';

/** Where the executable was found. */
export type HarnessExecutableSource = 'configured' | 'path' | 'well-known';

export type HarnessExecutableResolution =
  | {
      readonly found: true;
      /** Absolute path to spawn. */
      readonly path: string;
      readonly source: HarnessExecutableSource;
      /** Every place that was looked at, in order, up to and including the one that matched. */
      readonly searched: readonly string[];
    }
  | { readonly found: false; readonly searched: readonly string[] };

export interface HarnessExecutableSpec {
  /** The harness, as people read it (`Claude Code`). */
  readonly harness: string;
  /** The executable's default name (`claude`). */
  readonly name: string;
  /** The deployment's own command (an env var's value); blank means the default name. */
  readonly configured?: string;
  /** The setting that configures it, named in the "not found" reason (`FACTORY_CLAUDE_CODE_COMMAND`). */
  readonly setting?: string;
  /** The server's environment: `PATH`, `HOME`, `NVM_BIN`. `process.env` by default. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Directories looked at after PATH; {@link wellKnownExecutableDirs} by default. */
  readonly wellKnownDirs?: readonly string[];
  /** Whether a path is an executable file; the file system by default (tests swap it). */
  readonly isExecutable?: (path: string) => boolean;
  /** Reads `<path> --version`; the real CLI by default (tests swap it). */
  readonly readVersion?: (path: string) => Promise<string | undefined>;
  readonly platform?: NodeJS.Platform;
}

/** What `/web/config/versions` and the boot log say about one harness's executable. */
export interface HarnessExecutableReport {
  readonly harness: string;
  readonly name: string;
  readonly found: boolean;
  readonly path?: string;
  readonly source?: HarnessExecutableSource;
  /** The first line of `--version`, when it answered. */
  readonly version?: string;
  readonly searched: readonly string[];
  /** Why the harness cannot run, when it was not found. */
  readonly reason?: string;
}

/**
 * The command a CLI-backed harness spawns: a fixed one (tests, a host that resolved it itself),
 * or a source asked at every spawn, so an install after boot is picked up.
 */
export type HarnessCommand = string | HarnessCommandSource;

export interface HarnessCommandSource {
  /** The absolute path to spawn; throws {@link HarnessExecutableUnavailableError} when there is none. */
  command(): string;
  /** Told when spawning failed in a way only an install fixes (ENOENT, EACCES): the next `command()` looks again. */
  spawnFailed(error: unknown): void;
}

/**
 * The harness's executable is not there (or not executable). A retry cannot fix it: only an
 * install, or the deployment's setting, can. The dispatcher fails such a run once
 * (`harness_not_configured`) instead of retrying it.
 */
export class HarnessExecutableUnavailableError extends Error {
  /** Read structurally (`isHarnessExecutableUnavailable`), so a wrapped or re-thrown copy still counts. */
  readonly code = HARNESS_EXECUTABLE_UNAVAILABLE;
  readonly harness: string;
  readonly executable: string;
  readonly searched: readonly string[];

  constructor(fields: { harness: string; executable: string; searched?: readonly string[]; message?: string; cause?: unknown }) {
    super(fields.message ?? `${fields.harness} cannot start: \`${fields.executable}\` was not found on this server.`, fields.cause === undefined ? undefined : { cause: fields.cause });
    this.name = 'HarnessExecutableUnavailableError';
    this.harness = fields.harness;
    this.executable = fields.executable;
    this.searched = fields.searched ?? [];
  }
}

export const HARNESS_EXECUTABLE_UNAVAILABLE = 'harness_executable_unavailable';

/** Node's spawn errors that mean the executable itself is missing or not runnable: no retry fixes them. */
const PERMANENT_SPAWN_CODES = new Set(['ENOENT', 'EACCES', 'ENOTDIR', 'EISDIR', 'ENOEXEC']);
const MAX_CAUSE_DEPTH = 6;

function field(value: object, key: string): unknown {
  return (value as Record<string, unknown>)[key];
}

/** Whether `error` is a spawn of a missing or non-executable file (Node's `spawn <cmd> ENOENT`, …). */
export function isPermanentSpawnFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = field(error, 'code');
  const syscall = field(error, 'syscall');
  return typeof code === 'string' && PERMANENT_SPAWN_CODES.has(code) && typeof syscall === 'string' && syscall.startsWith('spawn');
}

/**
 * Whether a run failed because its harness's executable cannot be spawned: a
 * {@link HarnessExecutableUnavailableError}, or a permanent spawn failure, anywhere in the error's
 * `cause` (or `error`) chain. Harness errors (`ClaudeCodeError`, `CodexError`) keep the spawn
 * failure as their cause, so the run's error event carries it to the dispatcher.
 */
export function isHarnessExecutableUnavailable(error: unknown): boolean {
  const seen = new Set<object>();
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current && typeof current === 'object' && !seen.has(current); depth++) {
    seen.add(current);
    if (field(current, 'code') === HARNESS_EXECUTABLE_UNAVAILABLE || isPermanentSpawnFailure(current)) return true;
    current = field(current, 'cause') ?? field(current, 'error');
  }
  return false;
}

/** The path a {@link HarnessCommand} names right now, or `fallback` when there is none. */
export function harnessCommandPath(command: HarnessCommand | undefined, fallback: string): string {
  if (command === undefined) return fallback;
  return typeof command === 'string' ? command : command.command();
}

/**
 * Whether a {@link HarnessCommand} can be spawned now: a source that resolves, or a fixed command
 * that is an executable path or found on PATH (where Node's spawn looks for it).
 */
export function harnessCommandAvailable(
  command: HarnessCommand | undefined,
  name: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  if (command !== undefined && typeof command !== 'string') {
    try {
      command.command();
      return true;
    } catch {
      return false;
    }
  }
  return resolveHarnessExecutable({ harness: name, name, ...(command ? { configured: command } : {}), env, wellKnownDirs: [] }).found;
}

/** Tells a command source that spawning it failed, when the failure means the executable is gone. */
export function reportHarnessSpawnFailure(command: HarnessCommand | undefined, error: unknown): void {
  if (command && typeof command !== 'string' && isHarnessExecutableUnavailable(error)) command.spawnFailed(error);
}

/**
 * Where agent CLIs install outside the server's PATH, in the order they are looked at:
 * `~/.local/bin` (Claude Code's native installer), `~/.claude/local` (its older local install),
 * the bin of the node running this server and nvm's current node (npm's global installs, Codex),
 * Homebrew on Apple silicon, then `/usr/local/bin`.
 */
export function wellKnownExecutableDirs(
  input: { env?: Readonly<Record<string, string | undefined>>; home?: string; execPath?: string; platform?: NodeJS.Platform } = {},
): string[] {
  const env = input.env ?? process.env;
  const platform = input.platform ?? process.platform;
  if (platform === 'win32') return [];
  const home = input.home ?? env.HOME ?? homedir();
  const dirs = [
    home ? join(home, '.local', 'bin') : undefined,
    home ? join(home, '.claude', 'local') : undefined,
    dirname(input.execPath ?? process.execPath),
    env.NVM_BIN,
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ];
  return unique(dirs.filter((dir): dir is string => typeof dir === 'string' && dir.trim() !== ''));
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function fileIsExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Looks the executable up once: the configured path, else PATH, else the well-known directories. */
export function resolveHarnessExecutable(spec: HarnessExecutableSpec): HarnessExecutableResolution {
  const env = spec.env ?? process.env;
  const isExecutable = spec.isExecutable ?? fileIsExecutable;
  const configured = spec.configured?.trim();
  const command = configured || spec.name;
  if (isAbsolute(command) || command.includes('/')) {
    return isExecutable(command) ? { found: true, path: command, source: 'configured', searched: [command] } : { found: false, searched: [command] };
  }
  const platform = spec.platform ?? process.platform;
  const extensions = platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  const pathDirs = unique((env.PATH ?? '').split(delimiter).filter(Boolean));
  const wellKnown = (spec.wellKnownDirs ?? wellKnownExecutableDirs({ env, platform })).filter(dir => !pathDirs.includes(dir));
  const searched: string[] = [];
  const look = (dirs: readonly string[], source: HarnessExecutableSource): HarnessExecutableResolution | undefined => {
    for (const dir of dirs) {
      for (const extension of extensions) {
        const candidate = join(dir, `${command}${extension}`);
        searched.push(candidate);
        if (isExecutable(candidate)) return { found: true, path: candidate, source: configured ? 'configured' : source, searched: [...searched] };
      }
    }
    return undefined;
  };
  return look(pathDirs, 'path') ?? look(wellKnown, 'well-known') ?? { found: false, searched };
}

const VERSION_TIMEOUT_MS = 10_000;

/** The first line `<path> --version` prints, or undefined when it does not answer in time. */
export function readExecutableVersion(path: string): Promise<string | undefined> {
  return new Promise(resolve => {
    execFile(path, ['--version'], { timeout: VERSION_TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
      const line = error ? undefined : String(stdout).split('\n').map(text => text.trim()).find(Boolean);
      resolve(line || undefined);
    });
  });
}

/**
 * One harness's executable for the life of the server: resolved when first asked, kept once
 * found, looked up again while missing. It is the {@link HarnessCommandSource} the harness spawns.
 */
export interface HarnessExecutable extends HarnessCommandSource {
  readonly harness: string;
  readonly name: string;
  /** The current resolution: the kept one when found, a fresh lookup otherwise. */
  resolve(): HarnessExecutableResolution;
  /** Why the harness cannot run, for availability and errors; undefined when it was found. */
  unavailableReason(): string | undefined;
  /** Path, source and version (`--version` read once per path), or where it looked: the boot log and diagnostics. */
  report(): Promise<HarnessExecutableReport>;
}

export function createHarnessExecutable(spec: HarnessExecutableSpec): HarnessExecutable {
  const readVersion = spec.readVersion ?? readExecutableVersion;
  let kept: Extract<HarnessExecutableResolution, { found: true }> | undefined;
  const versions = new Map<string, Promise<string | undefined>>();

  const resolve = (): HarnessExecutableResolution => {
    if (kept) return kept;
    const resolution = resolveHarnessExecutable(spec);
    if (resolution.found) kept = resolution;
    return resolution;
  };
  const missingReason = (searched: readonly string[]): string => {
    const command = spec.configured?.trim() || spec.name;
    const looked = searched.length > 0 ? ` Looked in: ${searched.map(path => dirnameOf(path, command)).join(', ')}.` : '';
    const fix = spec.setting
      ? ` Install it, or set ${spec.setting} to its absolute path, and the harness becomes available without a restart.`
      : ' Install it, and the harness becomes available without a restart.';
    return `${spec.harness} is not installed on this server: \`${command}\` was not found.${looked}${fix}`;
  };

  return {
    harness: spec.harness,
    name: spec.name,
    resolve,
    unavailableReason() {
      const resolution = resolve();
      return resolution.found ? undefined : missingReason(resolution.searched);
    },
    command() {
      const resolution = resolve();
      if (resolution.found) return resolution.path;
      throw new HarnessExecutableUnavailableError({
        harness: spec.harness,
        executable: spec.configured?.trim() || spec.name,
        searched: resolution.searched,
        message: missingReason(resolution.searched),
      });
    },
    spawnFailed(error) {
      if (!isHarnessExecutableUnavailable(error)) return;
      if (kept) versions.delete(kept.path);
      kept = undefined;
    },
    async report() {
      const resolution = resolve();
      if (!resolution.found) {
        return { harness: spec.harness, name: spec.name, found: false, searched: resolution.searched, reason: missingReason(resolution.searched) };
      }
      let version = versions.get(resolution.path);
      if (!version) {
        version = readVersion(resolution.path).catch(() => undefined);
        versions.set(resolution.path, version);
      }
      const read = await version;
      return {
        harness: spec.harness,
        name: spec.name,
        found: true,
        path: resolution.path,
        source: resolution.source,
        ...(read ? { version: read } : {}),
        searched: resolution.searched,
      };
    },
  };
}

/** `/a/b/claude` → `/a/b`, for the "looked in" list; a configured path stays whole. */
function dirnameOf(path: string, command: string): string {
  return isAbsolute(command) || command.includes('/') ? path : dirname(path);
}

/** One line for the boot log: where the executable is and its version, or where it looked. */
export function formatHarnessExecutableReport(report: HarnessExecutableReport): string {
  if (!report.found) return `${report.harness}: \`${report.name}\` not found (looked in ${report.searched.length > 0 ? report.searched.join(', ') : 'nowhere'}).`;
  return `${report.harness}: ${report.path} (${report.source}${report.version ? `, ${report.version}` : ''}).`;
}
