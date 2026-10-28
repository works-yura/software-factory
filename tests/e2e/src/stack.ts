import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { startFakeGitLab, type FakeGitLab } from './fake-gitlab.ts';

export const REPO_ROOT = resolve(import.meta.dirname, '../../..');
export const FAKE_CLAUDE_SCRIPT = join(REPO_ROOT, 'tests/e2e/fake-claude/claude.mjs');
const SERVER_DIR = join(REPO_ROOT, 'apps/server');
const UI_DIR = join(REPO_ROOT, 'apps/ui');

/** Server boot (bundling included) takes 1-2 minutes, up to ~7 on a heavily loaded machine; past this something is wrong. */
const BOOT_TIMEOUT_MS = Number(process.env.FACTORY_E2E_BOOT_TIMEOUT_MS) || 12 * 60_000;
/** How often a boot in progress says so: the verify runner treats 5 silent minutes as a stall. */
const BOOT_PROGRESS_MS = 30_000;

export interface StackOptions {
  /** Shown in the scratch dir name. */
  label: string;
  /**
   * `fake` runs the fake CLI (tests/e2e/fake-claude); `real` leaves
   * FACTORY_CLAUDE_CODE_COMMAND unset so the server runs the real `claude`.
   */
  claude: 'fake' | 'real';
  /**
   * HOME is always a scratch directory, so nothing in ~/.mastracode is read or
   * written. For the real CLI, this links the person's Claude Code login into
   * it (~/.claude, ~/.claude.json, ~/Library/Keychains), so `claude` runs as
   * them; the real CLI then records its sessions in their ~/.claude as usual.
   */
  linkClaudeLogin?: boolean;
  /** Keep the scratch directory after `stop()` (also: FACTORY_E2E_KEEP=1). */
  keep?: boolean;
}

export interface Stack {
  baseUrl: string;
  port: number;
  scratch: string;
  gitlab: FakeGitLab;
  /** The fake CLI's per-invocation log (JSON lines); empty for the real CLI. */
  claudeLog: string;
  serverLog: string;
  sandboxRoot: string;
  readClaudeLog(): FakeClaudeInvocation[];
  tailServerLog(lines?: number): string;
  stop(): Promise<void>;
}

export interface FakeClaudeInvocation {
  argv: string[];
  cwd: string;
  prompt: string;
  sessionId?: string;
  scenario?: string;
  result?: string;
  signal?: string;
  mcp: Array<{ name: string; status: 'connected' | 'failed'; tools: string[]; error?: string }>;
  toolCalls: Array<{ tool: string; input: unknown; outcome?: string; result?: string; message?: string }>;
  permissionPrompts: Array<{ tool: string; reply: string }>;
}

export async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => (typeof address === 'object' && address ? resolvePort(address.port) : reject(new Error('no port'))));
    });
  });
}

function newestMtime(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const path = join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(path) : statSync(path).mtimeMs);
  }
  return newest;
}

/**
 * Builds apps/ui unless its dist is newer than every UI source file (the
 * server serves that dist). FACTORY_E2E_UI_BUILD=always|never overrides.
 */
export function ensureUiBuilt(log: (line: string) => void = console.log): void {
  const mode = process.env.FACTORY_E2E_UI_BUILD ?? 'auto';
  if (mode === 'never') return;
  const index = join(UI_DIR, 'dist/index.html');
  const fresh = existsSync(index) && statSync(index).mtimeMs > newestMtime(join(UI_DIR, 'src'));
  if (fresh && mode !== 'always') {
    log('[e2e] apps/ui/dist is up to date');
    return;
  }
  const started = Date.now();
  log('[e2e] building apps/ui');
  execFileSync('corepack', ['pnpm', 'run', 'build'], { cwd: UI_DIR, stdio: ['ignore', 'inherit', 'inherit'], timeout: 10 * 60_000 });
  log(`[e2e] apps/ui built in ${Math.round((Date.now() - started) / 1000)}s`);
}

/** Every descendant of `pid` (the dev server re-parents its server into its own process group). */
function descendants(pid: number): number[] {
  let table: string;
  try {
    table = execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' });
  } catch {
    return [];
  }
  const children = new Map<number, number[]>();
  for (const line of table.split('\n')) {
    const [child, parent] = line.trim().split(/\s+/).map(Number);
    if (!child || !parent) continue;
    children.set(parent, [...(children.get(parent) ?? []), child]);
  }
  const out: number[] = [];
  const queue = [pid];
  while (queue.length) {
    for (const child of children.get(queue.shift()!) ?? []) {
      out.push(child);
      queue.push(child);
    }
  }
  return out;
}

function signalTree(pids: number[], signal: NodeJS.Signals) {
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Waits for the test process (argv[1]) to die, then kills the pids in the file
 * (argv[2]) and their descendants, and removes the scratch directory holding
 * that file when argv[3] is `rm`.
 */
const REAPER = `
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const [parent, file, cleanup] = process.argv.slice(1);
const alive = pid => { try { process.kill(Number(pid), 0); return true; } catch { return false; } };
setInterval(() => {
  if (!fs.existsSync(file)) process.exit(0);
  if (alive(parent)) return;
  const pids = fs.readFileSync(file, 'utf8').split(/\\s+/).filter(Boolean).map(Number);
  try {
    const children = new Map();
    for (const line of execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' }).split('\\n')) {
      const [pid, ppid] = line.trim().split(/\\s+/).map(Number);
      if (pid && ppid) children.set(ppid, [...(children.get(ppid) || []), pid]);
    }
    const queue = [...pids];
    while (queue.length) for (const pid of children.get(queue.shift()) || []) if (!pids.includes(pid)) { pids.push(pid); queue.push(pid); }
  } catch {}
  for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  const dir = require('node:path').dirname(file);
  if (cleanup === 'rm' && require('node:path').basename(dir).startsWith('factory-e2e-')) {
    setTimeout(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} process.exit(0); }, 1000);
    return;
  }
  process.exit(0);
}, 2000);
`;

/** Environment the developer's shell may carry that would point the server somewhere other than the scratch stack. */
const STRIPPED_ENV = [
  /^DATABASE_URL$/,
  /^APP_DATABASE_URL$/,
  /^REDIS_URL$/,
  /^GITHUB_APP_/,
  /^GITLAB_/,
  /^WORKOS_/,
  /^MASTRA_PLATFORM_/,
  /^MASTRA_SHARED_API_URL$/,
  /^MASTRA_(PROJECT|ENVIRONMENT)_ID$/,
  /^E2B_API_KEY$/,
  /^FACTORY_/,
  /^MASTRACODE_/,
  /^MASTRA_DB_PATH$/,
  /^PORT$/,
  /^CLAUDECODE$/,
  /^CLAUDE_CODE_/,
  /^ANTHROPIC_/,
];

/**
 * The real dev server (`apps/server` `dev:local`: `mastra factory dev`, which
 * bundles the workspace packages into packages/*\/node_modules/.cache like a
 * production dev run) on a free port, with every data dir in a scratch
 * directory, the fake GitLab as its source control, and the chosen `claude`.
 *
 * Only one stack can run per checkout at a time: `dev:local` writes
 * apps/server/.mastra/output.
 */
export async function startStack(options: StackOptions): Promise<Stack> {
  const keep = options.keep ?? process.env.FACTORY_E2E_KEEP === '1';
  const scratch = mkdtempSync(join(process.env.FACTORY_E2E_TMP ?? tmpdir(), `factory-e2e-${options.label}-`));
  const home = join(scratch, 'home');
  const bin = join(scratch, 'bin');
  const sandboxRoot = join(scratch, 'sandboxes');
  const claudeLog = join(scratch, 'fake-claude.jsonl');
  const serverLog = join(scratch, 'server.log');
  for (const dir of [home, bin, sandboxRoot, join(scratch, 'git')]) mkdirSync(dir, { recursive: true });

  // The bundler shells out to a bare `pnpm`; this checkout only has it through corepack.
  writeFileSync(join(bin, 'pnpm'), '#!/bin/sh\nexec corepack pnpm "$@"\n');
  chmodSync(join(bin, 'pnpm'), 0o755);

  // The harness hands the CLI an allow-listed environment only, so the fake's settings travel in its wrapper.
  let claudeCommand: string | undefined;
  if (options.claude === 'fake') {
    claudeCommand = join(bin, 'claude');
    writeFileSync(
      claudeCommand,
      `#!/bin/sh\nexport FAKE_CLAUDE_LOG='${claudeLog}'\nexec '${process.execPath}' '${FAKE_CLAUDE_SCRIPT}' "$@"\n`,
    );
    chmodSync(claudeCommand, 0o755);
    writeFileSync(claudeLog, '');
  }

  const gitlab = await startFakeGitLab({ root: join(scratch, 'git') });
  // Trust the fake GitLab's certificate: Node (the server's API calls) through NODE_EXTRA_CA_CERTS, git in the
  // sandbox through the scratch HOME's gitconfig, and anything reading SSL_CERT_FILE (the sandbox passes it on)
  // through a bundle of the system roots plus it.
  const caBundle = join(scratch, 'ca-bundle.pem');
  const systemRoots = ['/etc/ssl/cert.pem', '/etc/ssl/certs/ca-certificates.crt'].find(existsSync);
  writeFileSync(caBundle, `${systemRoots ? readFileSync(systemRoots, 'utf8') : ''}\n${readFileSync(gitlab.caFile, 'utf8')}`);
  // Apple's git ignores SSL_CERT_FILE; the sandbox's git reads this HOME's gitconfig.
  writeFileSync(
    join(home, '.gitconfig'),
    `[user]\n\tname = Factory E2E\n\temail = e2e@factory.invalid\n[init]\n\tdefaultBranch = main\n[http]\n\tsslCAInfo = ${caBundle}\n`,
  );
  if (options.linkClaudeLogin) {
    for (const entry of ['.claude', '.claude.json', 'Library/Keychains']) {
      const target = join(homedir(), entry);
      if (!existsSync(target)) continue;
      mkdirSync(dirname(join(home, entry)), { recursive: true });
      symlinkSync(target, join(home, entry));
    }
  }
  const port = await freePort();
  const baseUrl = `http://localhost:${port}`;

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !STRIPPED_ENV.some(pattern => pattern.test(key))) env[key] = value;
  }
  Object.assign(env, {
    HOME: home,
    // corepack keeps pnpm under HOME; pin it to the person's cache so a scratch HOME does not re-download it.
    COREPACK_HOME: process.env.COREPACK_HOME ?? join(homedir(), '.cache/node/corepack'),
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    PORT: String(port),
    MASTRACODE_PUBLIC_URL: baseUrl,
    MASTRA_DB_PATH: join(scratch, 'mastra.db'),
    MASTRACODE_LOCAL_SANDBOX_ROOT: sandboxRoot,
    FACTORY_CLAUDE_CODE_STORE_DIR: join(scratch, 'claude-code-sessions'),
    GITLAB_ACCESS_TOKEN: gitlab.token,
    GITLAB_BASE_URL: gitlab.url,
    NODE_EXTRA_CA_CERTS: gitlab.caFile,
    SSL_CERT_FILE: caBundle,
    MASTRA_TELEMETRY_DISABLED: '1',
    CI: '1',
  });
  if (claudeCommand) env.FACTORY_CLAUDE_CODE_COMMAND = claudeCommand;

  const logStream = createWriteStream(serverLog);
  const child: ChildProcess = spawn('corepack', ['pnpm', 'run', 'dev:local'], {
    cwd: SERVER_DIR,
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.pipe(logStream, { end: false });
  child.stderr?.pipe(logStream, { end: false });
  let exited: number | null | undefined;
  child.on('exit', code => (exited = code));

  let stopped = false;
  const tracked = new Set<number>();
  const pidFile = join(scratch, 'server.pids');
  const track = () => {
    if (child.pid) for (const pid of [child.pid, ...descendants(child.pid)]) tracked.add(pid);
    if (!stopped) writeFileSync(pidFile, [...tracked].join('\n'));
  };
  track();
  // A runner that SIGKILLs this process (the verify watchdog) skips every exit hook, and the dev server
  // runs in process groups of its own; a detached reaper kills its tree once this process is gone.
  spawn(process.execPath, ['-e', REAPER, String(process.pid), pidFile, keep ? 'keep' : 'rm'], { detached: true, stdio: 'ignore' }).unref();
  // Last resort if the test process dies without teardown: no orphaned dev server.
  const onExit = () => {
    if (stopped) return;
    track();
    signalTree([...tracked], 'SIGKILL');
  };
  process.on('exit', onExit);

  const stop = async () => {
    if (stopped) return;
    track();
    stopped = true;
    rmSync(pidFile, { force: true });
    process.off('exit', onExit);
    const pids = [...tracked];
    signalTree(pids, 'SIGTERM');
    const deadline = Date.now() + 8_000;
    while (pids.some(alive) && Date.now() < deadline) await new Promise(r => setTimeout(r, 200));
    signalTree(pids.filter(alive), 'SIGKILL');
    // Turns the server started (the fake CLI, its MCP servers) were in its process groups; sweep stragglers.
    await gitlab.close();
    logStream.end();
    if (!keep) rmSync(scratch, { recursive: true, force: true });
  };

  const tailServerLog = (lines = 60) => {
    try {
      return readFileSync(serverLog, 'utf8').split('\n').slice(-lines).join('\n');
    } catch {
      return '';
    }
  };

  const started = Date.now();
  let lastProgress = started;
  try {
    while (true) {
      if (Date.now() - lastProgress > BOOT_PROGRESS_MS) {
        lastProgress = Date.now();
        const last = tailServerLog(5).split('\n').map(line => line.replace(/\x1b\[[0-9;]*m/g, '').trim()).filter(Boolean).at(-1);
        console.log(`[e2e] dev server still booting (${Math.round((Date.now() - started) / 1000)}s): ${last ?? '(no output yet)'}`);
      }
      if (exited !== undefined) throw new Error(`dev server exited (${exited}) before it was ready`);
      if (Date.now() - started > BOOT_TIMEOUT_MS) throw new Error(`dev server not ready after ${BOOT_TIMEOUT_MS / 1000}s`);
      track();
      try {
        const res = await fetch(`${baseUrl}/web/config/features`, { signal: AbortSignal.timeout(3_000) });
        if (res.ok) break;
      } catch {
        // Not listening yet.
      }
      await new Promise(r => setTimeout(r, 1_000));
    }
  } catch (error) {
    const tail = tailServerLog(80);
    await stop();
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n--- server log ---\n${tail}`);
  }
  track();
  console.log(`[e2e] dev server ready on ${baseUrl} in ${Math.round((Date.now() - started) / 1000)}s (scratch ${scratch})`);

  return {
    baseUrl,
    port,
    scratch,
    gitlab,
    claudeLog,
    serverLog,
    sandboxRoot,
    readClaudeLog: () =>
      existsSync(claudeLog)
        ? readFileSync(claudeLog, 'utf8')
            .split('\n')
            .filter(line => line.trim())
            .map(line => JSON.parse(line) as FakeClaudeInvocation)
        : [],
    tailServerLog,
    stop,
  };
}
