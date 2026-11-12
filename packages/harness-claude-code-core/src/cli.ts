import { spawn as nodeSpawn } from 'node:child_process';

import { harnessCommandPath, reportHarnessSpawnFailure, type HarnessCommand } from '@factory/harness/executable';

import { createLineSplitter } from './stream.ts';

/**
 * Permission modes the harness passes to the CLI. `bypassPermissions` is
 * deliberately left out: an unattended agent never skips permission checks;
 * it runs with the tools its configuration allows. `plan` is left out too:
 * `claude -p` has no ExitPlanMode, and plan mode writes plan files into the
 * config dir (`~/.claude/plans`). The harness plans with its own gate instead
 * (see {@link ClaudeSessionMode}).
 */
export type ClaudePermissionMode = 'default' | 'acceptEdits' | 'auto' | 'dontAsk' | 'manual';

/**
 * How a session's turns run: a CLI permission mode, or `planning`, the
 * harness's own plan mode: the default permission mode with file edits denied
 * and a prompt to finish with `submit_plan` (see `gate.ts`).
 */
export type ClaudeSessionMode = ClaudePermissionMode | 'planning';

/** Where the CLI may read settings from. `user` is the person's own `~/.claude/settings.json`. */
export type ClaudeSettingSource = 'user' | 'project' | 'local';

const FORBIDDEN_ARGS = new Set(['--dangerously-skip-permissions', '--allow-dangerously-skip-permissions']);

export interface ClaudeArgsInput {
  resumeSessionId?: string;
  model?: string;
  effort?: string;
  permissionMode?: ClaudePermissionMode;
  /**
   * MCP server configs: each a path, a JSON string, or a config object
   * (serialised to JSON). They are passed as one `--mcp-config` list.
   */
  mcpConfig?: string | Record<string, unknown> | Array<string | Record<string, unknown>>;
  /** Only use the MCP servers from {@link mcpConfig}, ignoring the user's and project's. */
  strictMcpConfig?: boolean;
  /** `--setting-sources`; left out, the CLI reads all of them. */
  settingSources?: ClaudeSettingSource[];
  /** `--settings`: extra settings as an object (serialised to JSON). */
  settings?: Record<string, unknown>;
  allowedTools?: string[];
  disallowedTools?: string[];
  /**
   * `--permission-prompt-tool`: the MCP tool the CLI asks whenever a tool call
   * needs permission. Without one, `-p` silently refuses such calls.
   */
  permissionPromptTool?: string;
  appendSystemPrompt?: string;
  includePartialMessages?: boolean;
  maxTurns?: number;
  extraArgs?: string[];
}

/**
 * Arguments for one non-interactive turn. Input is stream-json on stdin (see
 * {@link runClaude}): the prompt is the first user message, and stdin stays
 * open while the turn runs, so a person's steer joins the turn in flight and
 * the CLI's control requests (an MCP server's elicitation) can be answered.
 */
export function buildClaudeArgs(input: ClaudeArgsInput): string[] {
  // `-p` defaults thinking to `display: "omitted"`: blocks arrive with empty text
  // (signature only). Ask for summaries so the UI can show the reasoning.
  const args = [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--thinking-display',
    'summarized',
  ];
  if (input.includePartialMessages) args.push('--include-partial-messages');
  if (input.resumeSessionId) args.push('--resume', input.resumeSessionId);
  if (input.model) args.push('--model', input.model);
  if (input.effort) args.push('--effort', input.effort);
  if (input.permissionMode) {
    const mode = input.permissionMode as string;
    if (mode === 'bypassPermissions') throw new Error('Claude Code harness never runs with bypassPermissions.');
    if (mode === 'plan') {
      throw new Error("Claude Code harness does not use the CLI's plan mode; use the session mode 'planning'.");
    }
    args.push('--permission-mode', input.permissionMode);
  }
  if (input.settingSources) args.push('--setting-sources', input.settingSources.join(','));
  if (input.settings && Object.keys(input.settings).length > 0) args.push('--settings', JSON.stringify(input.settings));
  const mcpConfigs = input.mcpConfig === undefined ? [] : Array.isArray(input.mcpConfig) ? input.mcpConfig : [input.mcpConfig];
  if (mcpConfigs.length > 0) {
    args.push('--mcp-config', ...mcpConfigs.map(config => (typeof config === 'string' ? config : JSON.stringify(config))));
  }
  if (input.strictMcpConfig) args.push('--strict-mcp-config');
  if (input.allowedTools?.length) args.push('--allowedTools', input.allowedTools.join(','));
  if (input.disallowedTools?.length) args.push('--disallowedTools', input.disallowedTools.join(','));
  if (input.permissionPromptTool) args.push('--permission-prompt-tool', input.permissionPromptTool);
  if (input.maxTurns && input.maxTurns > 0) args.push('--max-turns', String(input.maxTurns));
  if (input.appendSystemPrompt) args.push('--append-system-prompt', input.appendSystemPrompt);
  for (const arg of input.extraArgs ?? []) {
    if (FORBIDDEN_ARGS.has(arg.split('=')[0]!)) {
      throw new Error(`Claude Code harness never passes ${arg}.`);
    }
    args.push(arg);
  }
  return args;
}

/**
 * Environment variables that pick the CLI's credentials. They are always
 * stripped from the inherited environment so a key in the server's own env
 * never outranks the one the credentials hook chose for this turn.
 */
export const CREDENTIAL_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'AWS_BEARER_TOKEN_BEDROCK',
  'CLAUDE_CONFIG_DIR',
  // Where the CLI reads its stored sign-in; only the credentials hook may point it somewhere.
  'CLAUDE_SECURESTORAGE_CONFIG_DIR',
] as const;

/** Set inside a Claude Code session; a nested `claude` refuses to start when it sees them. */
const NESTED_SESSION_ENV_KEYS = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT'];

/**
 * What a turn inherits from the server's environment: what the CLI, git and
 * a shell need to run (paths, locale, temp dirs, proxies, CA bundles) and
 * nothing else. The server's own secrets (database URLs, provider and
 * GitHub tokens, signing keys) stay out of reach of the agent; hosts add
 * names with `passEnv`.
 */
export const DEFAULT_CLAUDE_ENV_ALLOWLIST: readonly string[] = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LANGUAGE',
  'TERM',
  'COLORTERM',
  'TZ',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  // Windows
  'SYSTEMROOT',
  'COMSPEC',
  'PATHEXT',
  'APPDATA',
  'LOCALAPPDATA',
  'USERPROFILE',
];
const ALLOWED_ENV_PREFIXES = ['LC_', 'XDG_'];

export function buildClaudeEnv(
  base: Record<string, string | undefined>,
  credentials: Record<string, string>,
  passEnv: readonly string[] = [],
): Record<string, string> {
  const env: Record<string, string> = {};
  const allowed = new Set<string>([...DEFAULT_CLAUDE_ENV_ALLOWLIST, ...passEnv]);
  const drop = new Set<string>([...CREDENTIAL_ENV_KEYS, ...NESTED_SESSION_ENV_KEYS]);
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined || drop.has(key)) continue;
    if (allowed.has(key) || ALLOWED_ENV_PREFIXES.some(prefix => key.startsWith(prefix))) env[key] = value;
  }
  // The CLI keeps the turn's credentials (API key, OAuth token) out of the shells and MCP servers it starts.
  return { ...env, ...credentials, CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1' };
}

/** The slice of a Node child process the runner uses, so tests can hand in a fake. */
export interface ClaudeChildProcess {
  readonly pid?: number | undefined;
  readonly stdin: {
    write(chunk: string): unknown;
    end(chunk?: string): unknown;
    on?(event: 'error', listener: (error: Error) => void): unknown;
  } | null;
  readonly stdout: { setEncoding?(encoding: 'utf8'): unknown; on(event: 'data', listener: (chunk: string | Buffer) => void): unknown } | null;
  readonly stderr: { setEncoding?(encoding: 'utf8'): unknown; on(event: 'data', listener: (chunk: string | Buffer) => void): unknown } | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

export type ClaudeSpawn = (
  command: string,
  args: string[],
  options: { cwd: string; env: Record<string, string>; detached: boolean; stdio: ['pipe', 'pipe', 'pipe'] },
) => ClaudeChildProcess;

export interface ClaudeExit {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  timedOut: boolean;
  /** Set when {@link ClaudeRun.terminate} stopped the process. */
  terminated: boolean;
  /** The process never started (missing binary, bad cwd). */
  spawnError?: Error;
}

export interface ClaudeRun {
  readonly pid: number | undefined;
  readonly exited: Promise<ClaudeExit>;
  isAlive(): boolean;
  /** Stops the turn: SIGTERM to the process group, SIGKILL after a grace period. */
  terminate(): void;
  /**
   * Writes one stream-json message to the CLI's stdin (a user message, a
   * control response); `false` when the process is gone or its input closed.
   */
  send(message: Record<string, unknown>): boolean;
  /** Whether {@link send} can still reach the CLI. */
  acceptsInput(): boolean;
  /** Closes stdin: the CLI finishes what it has queued and exits. */
  closeInput(): void;
  /** Stops the turn's time budget, e.g. while it waits for a person. */
  pauseTimeout(): void;
  /** Starts the turn's time budget again, from the full budget. */
  resumeTimeout(): void;
}

/** A user message as the CLI's stream-json input takes it. */
export function userMessage(text: string): Record<string, unknown> {
  return { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null };
}

export interface RunClaudeInput {
  /** The CLI: a path, or the server's resolver (`@factory/harness/executable`); `claude` on PATH by default. */
  command?: HarnessCommand;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  /** The turn's first user message, written to stdin as stream-json; stdin stays open after it. */
  prompt: string;
  onLine: (line: string) => void;
  spawn?: ClaudeSpawn;
  /** The whole turn's budget; past it the process is terminated. */
  timeoutMs?: number;
  killGraceMs?: number;
}

const STDERR_LIMIT = 64 * 1024;

/**
 * Runs one `claude` turn. The real CLI runs in its own process group so
 * terminating a turn also stops the tools it spawned (shells, MCP servers);
 * an injected spawn gets a plain `kill`, since its pid is not ours to signal.
 */
export function runClaude(input: RunClaudeInput): ClaudeRun {
  const usesNodeSpawn = !input.spawn;
  const spawn = input.spawn ?? (nodeSpawn as unknown as ClaudeSpawn);
  let alive = true;
  let terminated = false;
  let timedOut = false;
  let stderr = '';
  let killTimer: NodeJS.Timeout | undefined;
  let timeoutTimer: NodeJS.Timeout | undefined;
  let resolveExit!: (exit: ClaudeExit) => void;
  const exited = new Promise<ClaudeExit>(resolve => {
    resolveExit = resolve;
  });
  const lines = createLineSplitter(input.onLine);

  let child: ClaudeChildProcess;
  try {
    // A resolver with no `claude` throws here: the turn fails at once with why, as a failed spawn does.
    child = spawn(harnessCommandPath(input.command, 'claude'), input.args, {
      cwd: input.cwd,
      env: input.env,
      detached: usesNodeSpawn,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    alive = false;
    reportHarnessSpawnFailure(input.command, error);
    resolveExit({
      exitCode: null,
      signal: null,
      stderr: '',
      timedOut: false,
      terminated: false,
      spawnError: error instanceof Error ? error : new Error(String(error)),
    });
    const none = () => {};
    return {
      pid: undefined,
      exited,
      isAlive: () => false,
      terminate: none,
      send: () => false,
      acceptsInput: () => false,
      closeInput: none,
      pauseTimeout: none,
      resumeTimeout: none,
    };
  }

  const signal = (sig: NodeJS.Signals) => {
    if (usesNodeSpawn && child.pid) {
      try {
        process.kill(-child.pid, sig);
        return;
      } catch {
        // The group is gone or was never created; fall back to the child itself.
      }
    }
    try {
      child.kill(sig);
    } catch {
      // Already exited.
    }
  };
  const terminate = () => {
    if (!alive || terminated) return;
    terminated = true;
    signal('SIGTERM');
    killTimer = setTimeout(() => {
      if (alive) signal('SIGKILL');
    }, input.killGraceMs ?? 5_000);
    killTimer.unref?.();
  };

  const finish = (exit: Omit<ClaudeExit, 'stderr' | 'timedOut' | 'terminated'>) => {
    if (!alive) return;
    alive = false;
    clearTimeout(killTimer);
    clearTimeout(timeoutTimer);
    lines.flush();
    resolveExit({ ...exit, stderr, timedOut, terminated });
  };

  child.stdout?.setEncoding?.('utf8');
  child.stderr?.setEncoding?.('utf8');
  child.stdout?.on('data', chunk => lines.push(String(chunk)));
  child.stderr?.on('data', chunk => {
    if (stderr.length < STDERR_LIMIT) stderr += String(chunk);
  });
  child.on('error', (error: Error) => {
    // Node reports a missing or non-executable file here (`spawn claude ENOENT`): the resolver looks again next time.
    reportHarnessSpawnFailure(input.command, error);
    finish({ exitCode: null, signal: null, spawnError: error });
  });
  child.on('close', (code: number | null, sig: NodeJS.Signals | null) => finish({ exitCode: code, signal: sig }));
  // The CLI may exit before reading stdin; a broken pipe is not the turn's failure, it only ends the input.
  let inputOpen = !!child.stdin;
  child.stdin?.on?.('error', () => {
    inputOpen = false;
  });
  const acceptsInput = () => alive && inputOpen;
  const send = (message: Record<string, unknown>) => {
    if (!acceptsInput()) return false;
    try {
      child.stdin!.write(`${JSON.stringify(message)}\n`);
      return true;
    } catch {
      inputOpen = false;
      return false;
    }
  };
  const closeInput = () => {
    if (!inputOpen) return;
    inputOpen = false;
    try {
      child.stdin!.end();
    } catch {
      // Already closed.
    }
  };
  send(userMessage(input.prompt));

  const pauseTimeout = () => {
    clearTimeout(timeoutTimer);
    timeoutTimer = undefined;
  };
  const resumeTimeout = () => {
    pauseTimeout();
    if (!alive || !input.timeoutMs || input.timeoutMs <= 0) return;
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, input.timeoutMs);
    timeoutTimer.unref?.();
  };
  resumeTimeout();

  return { pid: child.pid, exited, isAlive: () => alive, terminate, send, acceptsInput, closeInput, pauseTimeout, resumeTimeout };
}
