import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { FactorySandbox, LocalSandbox } from '@mastra/core/workspace';
import type { FactorySandboxBuilds, FactorySandboxContext } from '@mastra/core/workspace';

import type { AgentProcesses } from './agent-processes.ts';
import { hostExecutor } from './template/host-exec.ts';
import type { FactorySandboxCheckoutServices, LocalEnvironmentTemplate } from './template/local-template.ts';
import { localSandboxSettingsSchema } from './template/local-sandbox-settings.ts';
import { WORK_ITEM_FOLDERS_DIR } from './work-item-folder.ts';
import { resolveContainedLocalWorkdir } from './workdir.ts';

export interface LocalFactorySandboxOptions {
  /** Directory under which every session (or card) gets its own working directory. */
  root: string;
  /** Environment for commands run in the sandbox. */
  env?: Record<string, string>;
  /**
   * The environment template (ADR-0039): repository mirrors, builds, shared
   * package stores, session work kept outside the folder. Without it every
   * session clones from the network and a removed folder takes its work along.
   */
  template?: LocalEnvironmentTemplate;
  /** Tests: the rename that moves a folder to the trash (to simulate another volume). */
  renameForRemoval?: (from: string, to: string) => Promise<void>;
  /** Sandbox commands (the agent's, the session's setup) run as the agent user, not as the server (ADR-0041). */
  agentProcesses?: AgentProcesses;
}

/**
 * Which processes left in a sandbox folder Factory started: descendants of
 * the server (sandbox commands, harness CLIs and theirs), processes carrying
 * the sandbox marker in their environment where it can be read (Linux), and,
 * where it cannot (macOS), orphans with no terminal (a `nohup` job whose shell
 * exited; a person's shell or editor has a terminal or a living parent).
 * Everything else is left running.
 */
export function classifyFolderProcesses(input: {
  candidates: readonly number[];
  processes: ReadonlyMap<number, { parent: number; tty: boolean }>;
  serverPid: number;
  marked: ReadonlySet<number>;
  envReadable: boolean;
}): { ours: number[]; left: number[] } {
  const descendsFromServer = (target: number) => {
    for (let current = input.processes.get(target)?.parent, hops = 0; current && current > 1 && hops < 64; hops++) {
      if (current === input.serverPid) return true;
      current = input.processes.get(current)?.parent;
    }
    return false;
  };
  const ours: number[] = [];
  const left: number[] = [];
  for (const target of input.candidates) {
    const info = input.processes.get(target);
    const orphanWithoutTerminal = info !== undefined && info.parent === 1 && !info.tty;
    if (descendsFromServer(target) || input.marked.has(target) || (!input.envReadable && orphanWithoutTerminal)) ours.push(target);
    else left.push(target);
  }
  return { ours, left };
}

/** Marks every process a local sandbox starts with its folder key. */
export const SANDBOX_MARKER_ENV = 'FACTORY_SANDBOX_FOLDER';
/** Left in a folder deleted in place, so an interrupted delete is finished, never reused. */
const DELETING_MARKER = '.factory-deleting';

/**
 * What factory hands a sandbox constructor: core's context plus the card
 * folder the session works in. `workItemFolder` is the folder's path relative
 * to the sandbox root (`work-items/<factory>/<card branch>`), set when the
 * session works a card; every session of that card gets the same one. A
 * provider that cannot share disk between sessions may ignore it.
 */
export type FactoryWorkspaceSandboxContext = FactorySandboxContext & { workItemFolder?: string };

/**
 * `LocalSandbox.destroy()` stops processes but keeps the working directory.
 * Every other provider's destroy takes the session's disk with it, so this one
 * does too: a destroyed local session leaves no checkout behind. A card's
 * folder is shared by its sessions, so destroying one of them only stops its
 * processes; the folder goes with the card (`removeWorkItemFolder`).
 */
class SessionLocalSandbox extends LocalSandbox {
  readonly #root: string;
  readonly #shared: boolean;
  readonly #legacyDirectory: string | undefined;
  readonly #removeOwnFolder: (directory: string, sessionId: string) => Promise<void>;

  constructor(
    options: ConstructorParameters<typeof LocalSandbox>[0],
    root: string,
    shared: boolean,
    legacyDirectory: string | undefined,
    removeOwnFolder: (directory: string, sessionId: string) => Promise<void>,
    agent?: AgentProcesses,
  ) {
    super(options);
    this.#root = resolve(root);
    this.#shared = shared;
    this.#legacyDirectory = legacyDirectory;
    this.#removeOwnFolder = removeOwnFolder;
    if (agent) runProcessesAsAgent(this, agent);
  }

  /**
   * A session that had a folder of its own before cards shared one brings its
   * checkout along: the first such session to start in a card folder that does
   * not exist yet moves its old folder there, so its work is not left behind.
   * The old path stays as a link to the card folder, because a Claude Code
   * session keeps the working directory its first turn recorded.
   */
  protected override async find(): Promise<string | undefined> {
    if (this.#legacyDirectory) await adoptLegacyFolder(this.#legacyDirectory, resolve(this.workingDirectory));
    return super.find();
  }

  /** True when this session works in its card's shared folder. */
  get sharedWorkItemFolder(): boolean {
    return this.#shared;
  }

  override async destroy(): Promise<void> {
    await super.destroy();
    if (this.#shared) return;
    const directory = resolve(this.workingDirectory);
    // Only a session's own directory under the root, never the root itself or anything outside it.
    if (!directory.startsWith(this.#root + sep)) return;
    // Its work goes to the mirror first; when that cannot be verified the folder stays (and this throws).
    await this.#removeOwnFolder(directory, this.id);
  }
}

/**
 * Sessions run on the host machine: each session's sandbox is a LocalSandbox
 * rooted at `join(root, sessionId)`, where the repository checks out as a
 * subdirectory. A session that works a card is rooted at the card's folder
 * instead (`<root>/work-items/<factory>/<card branch>`), shared by every
 * session of that card. No template and no user-tunable settings.
 */
export class LocalFactorySandbox extends FactorySandbox<Record<string, never>> {
  readonly provider = 'local';

  readonly #options: LocalFactorySandboxOptions;
  /** Environment builds, present with a template: the same workflow, triggers and UI as remote templates. */
  override readonly builds: FactorySandboxBuilds<Record<string, never>> | undefined;
  /** The Factory-tunable sleep limits and hidden-ref retention (Settings › Environment › Sandbox). */
  override readonly settings = localSandboxSettingsSchema as never;
  /** Folders (keys) being put to sleep: their removal keeps the record, as asleep. */
  readonly #sleeping = new Set<string>();

  constructor(options: LocalFactorySandboxOptions) {
    super();
    this.#options = options;
    this.builds = options.template?.builds;
    const template = options.template;
    // A crash mid-delete leaves only the trash behind; empty it.
    void this.emptyTrash();
    if (template) {
      // Saved commits set aside by a save: the person hears it on the folder's record.
      template.onNotice = notice => {
        const key = this.folderKeyOf(notice.dir);
        if (!key) return;
        void template.sandboxes
          .addProblem(key, { kind: 'superseded', message: `${notice.branch}: saved commits the new tip does not contain were kept at ${notice.ref}` }, this.#recordDefaults(key))
          .catch(() => {});
      };
    }
  }

  /** The record's kind and Factory as the key tells them. */
  #recordDefaults(key: string): { kind: 'card' | 'session'; factoryProjectId?: string } {
    const segments = key.split('/');
    return segments[0] === WORK_ITEM_FOLDERS_DIR ? { kind: 'card', factoryProjectId: segments[1]! } : { kind: 'session' };
  }

  /**
   * Remove a sandbox folder with its work put to sleep first; the record
   * follows: gone (or asleep, when the sleeper removes it), and a failed save
   * becomes a problem the person sees, with the folder kept.
   */
  async #removeFolder(
    directory: string,
    options: { publish: boolean; sessionId?: string; mayRemove?: () => Promise<boolean> },
  ): Promise<boolean> {
    const template = this.#options.template;
    if (!template) {
      await this.#removeDirectory(directory);
      return true;
    }
    const key = this.folderKeyOf(directory);
    let removed = false;
    const remove = async () => {
      // Checked again at the last moment: work may have started while the save ran.
      if (options.mayRemove && !(await options.mayRemove())) return;
      await this.#removeDirectory(directory);
      removed = true;
    };
    try {
      // Published while no sleeper holds it: the card is closing (its refs may go sooner, ADR-0039).
      const closing = options.publish && Boolean(key) && !this.#sleeping.has(key!);
      const { mayRemove: _mayRemove, ...rest } = options;
      const notices = await template.removeFolder(directory, { ...rest, closing, remove });
      if (key && notices.length) {
        await template.sandboxes
          .addProblem(key, { kind: 'public-repository', message: notices.join('\n') }, this.#recordDefaults(key))
          .catch(() => {});
      }
    } catch (error) {
      if (key) {
        await template.sandboxes
          .addProblem(key, { kind: 'save-failed', message: error instanceof Error ? error.message : String(error) }, this.#recordDefaults(key))
          .catch(() => {});
      }
      throw error;
    }
    if (removed && key && !this.#sleeping.has(key)) await template.sandboxes.remove(key).catch(() => {});
    return removed;
  }

  /** Where folders go to be deleted: renamed there first (atomic), so a crash mid-delete never leaves a half folder in use. */
  #trash(): string {
    return join(resolve(this.#options.root), '.trash');
  }

  async #removeDirectory(directory: string): Promise<void> {
    const trash = this.#trash();
    await mkdir(trash, { recursive: true });
    const away = join(trash, randomUUID());
    try {
      await (this.#options.renameForRemoval ?? rename)(directory, away);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return;
      if (code !== 'EXDEV') throw error;
      // Another volume (a folder mounted or linked from elsewhere): deleted where it is, marked
      // first, so a crash midway leaves a folder the next start finishes deleting, never reuses.
      await writeFile(join(directory, DELETING_MARKER), new Date().toISOString());
      await rm(directory, { recursive: true, force: true });
      return;
    }
    await rm(away, { recursive: true, force: true });
  }

  /**
   * Finish deletes a crash interrupted (at start): the trash, and any folder
   * marked as being deleted in place. Never touches a folder in use.
   */
  async emptyTrash(): Promise<void> {
    await rm(this.#trash(), { recursive: true, force: true }).catch(() => {});
    const root = resolve(this.#options.root);
    const candidates: string[] = [];
    const children = async (dir: string) =>
      (await readdir(dir, { withFileTypes: true }).catch(() => [])).filter(entry => entry.isDirectory()).map(entry => join(dir, entry.name));
    for (const dir of await children(root)) {
      if (dir === join(root, WORK_ITEM_FOLDERS_DIR)) {
        for (const factory of await children(dir)) candidates.push(...(await children(factory)));
      } else {
        candidates.push(dir);
      }
    }
    for (const folder of candidates) {
      const marked = await stat(join(folder, DELETING_MARKER)).then(
        () => true,
        () => false,
      );
      if (marked) await rm(folder, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * Stop the processes left working in the folder that Factory started:
   * descendants of this server (a sandbox command, a harness CLI and their
   * children), or carrying the sandbox's marker in their environment (what a
   * `nohup` left behind after its shell exited). SIGTERM, then SIGKILL after a
   * grace period. Anyone else's (a person's shell or editor in the folder) is
   * logged and left. `unchecked` when the processes could not be listed.
   */
  async stopProcessesIn(directory: string, graceMs = 3_000): Promise<{ stopped: number[]; left: number[]; unchecked: boolean }> {
    const host = hostExecutor();
    const listed = await host.executeCommand('lsof', ['-a', '-d', 'cwd', '-F', 'pn'], { timeout: 30_000 });
    // lsof exits 1 when some processes cannot be read; only no output at all means it could not look.
    if (!listed.stdout.trim()) {
      console.warn('[factory:sleep] could not list the processes in a sandbox folder; some may keep running', {
        directory,
        exitCode: listed.exitCode,
        error: listed.stderr.trim().slice(-300),
      });
      return { stopped: [], left: [], unchecked: true };
    }
    // lsof names the real path (/private/var/… for /var/…).
    const folder = await realpath(directory).catch(() => resolve(directory));
    const inFolder: number[] = [];
    let pid: number | undefined;
    for (const line of listed.stdout.split('\n')) {
      if (line.startsWith('p')) pid = Number(line.slice(1));
      else if (line.startsWith('n') && pid && pid !== process.pid) {
        const cwd = line.slice(1);
        if (cwd === folder || cwd.startsWith(folder + sep)) inFolder.push(pid);
      }
    }
    const candidates = [...new Set(inFolder)];
    if (!candidates.length) return { stopped: [], left: [], unchecked: false };
    const table = await host.executeCommand('ps', ['-A', '-o', 'pid=,ppid=,tty='], { timeout: 30_000 });
    const processes = new Map<number, { parent: number; tty: boolean }>();
    for (const row of table.stdout.split('\n')) {
      const [child, parent, tty] = row.trim().split(/\s+/);
      if (child && parent) processes.set(Number(child), { parent: Number(parent), tty: Boolean(tty) && tty !== '??' && tty !== '?' });
    }
    const marked = new Set<number>();
    if (process.platform === 'linux') {
      for (const target of candidates) {
        const env = await readFile(`/proc/${target}/environ`, 'utf8').catch(() => '');
        if (env.includes(`${SANDBOX_MARKER_ENV}=`)) marked.add(target);
      }
    }
    const { ours, left } = classifyFolderProcesses({ candidates, processes, serverPid: process.pid, marked, envReadable: process.platform === 'linux' });
    if (left.length) console.warn('[factory:sleep] processes in a sandbox folder that Factory did not start are left running', { directory, pids: left });
    const alive = (target: number) => {
      try {
        process.kill(target, 0);
        return true;
      } catch {
        return false;
      }
    };
    for (const target of ours) {
      try {
        process.kill(target, 'SIGTERM');
      } catch {
        // Gone already.
      }
    }
    const deadline = Date.now() + graceMs;
    while (ours.some(alive) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    const stubborn = ours.filter(alive);
    for (const target of stubborn) {
      try {
        process.kill(target, 'SIGKILL');
      } catch {
        // Gone already.
      }
    }
    if (ours.length) console.warn('[factory:sleep] stopped processes left in a sandbox folder', { directory, pids: ours, killed: stubborn });
    return { stopped: ours, left, unchecked: false };
  }

  /** The folder key (`<session>` or `work-items/<factory>/<card>`) a path lies in. */
  folderKeyOf(directory: string): string | undefined {
    const folder = this.folderRootOf(directory);
    if (!folder) return undefined;
    return relative(resolve(this.#options.root), folder).split(sep).join('/');
  }

  /** The folder's path for its key; `undefined` for a key outside the root. */
  folderPathOf(key: string): string | undefined {
    try {
      return key.startsWith(`${WORK_ITEM_FOLDERS_DIR}/`) ? this.workItemFolderPath(key) : resolveContainedLocalWorkdir(this.#options.root, key);
    } catch {
      return undefined;
    }
  }

  /** The folder's size on disk in bytes (hard links counted once); `undefined` when it cannot be read. */
  async folderSize(key: string): Promise<number | undefined> {
    const folder = this.folderPathOf(key);
    if (!folder) return undefined;
    const result = await hostExecutor().executeCommand('du', ['-sk', folder], { timeout: 60_000 });
    const kb = Number(result.stdout.trim().split(/\s+/)[0]);
    return result.exitCode === 0 && Number.isFinite(kb) ? kb * 1024 : undefined;
  }

  /**
   * Put a sandbox folder to sleep (the sleeper decided it may): a session's
   * own folder is saved and published first, then its sessions are released
   * (a released own session's sandbox removes its folder); a card's sessions
   * are released first and the folder then saved, published and removed. The
   * folder's record stays, asleep. Throws when anything could not be kept.
   */
  async sleepFolder(
    key: string,
    input: { sessionIds: string[]; release: (sessionId: string) => Promise<void>; stillIdle: () => Promise<boolean> },
  ): Promise<'slept' | 'active'> {
    const template = this.#options.template;
    const directory = this.folderPathOf(key);
    if (!template || !directory) throw new Error(`No sandbox folder for ${key}`);
    this.#sleeping.add(key);
    try {
      // Checked right before each irreversible step: a message may have started a run meanwhile.
      if (!(await input.stillIdle())) return 'active';
      // Released first, card or session alike: processes stop; a released session's own folder
      // stays while it sleeps (its removal below is the one that saves, publishes and checks).
      for (const sessionId of input.sessionIds) await input.release(sessionId);
      if (!(await input.stillIdle())) return 'active';
      const processes = await this.stopProcessesIn(directory);
      if (processes.unchecked) {
        await template.sandboxes
          .addProblem(
            key,
            { kind: 'processes-unchecked', message: 'The processes in the folder could not be listed (lsof); some may still run and hold ports.' },
            this.#recordDefaults(key),
          )
          .catch(() => {});
      }
      const removed = await this.#removeFolder(directory, { publish: true, mayRemove: input.stillIdle });
      return removed ? 'slept' : 'active';
    } finally {
      this.#sleeping.delete(key);
    }
  }

  /** The environment template, when configured. */
  get environmentTemplate(): LocalEnvironmentTemplate | undefined {
    return this.#options.template;
  }

  /** What materialization clones from and keeps session work in (ADR-0039). */
  get checkoutServices(): FactorySandboxCheckoutServices | undefined {
    return this.#options.template?.checkoutServices;
  }

  /** The sandbox environment plus the template's shared package stores. */
  #env(): Record<string, string> | undefined {
    const stores = this.#options.template?.packageStoreEnv();
    if (!stores || Object.keys(stores).length === 0) return this.#options.env;
    return { ...stores, ...this.#options.env };
  }

  /** The absolute directory of a card folder; refuses a key outside `<root>/work-items`. */
  workItemFolderPath(folder: string): string {
    const segments = folder.split('/');
    if (segments[0] !== WORK_ITEM_FOLDERS_DIR || segments.length < 2 || segments.some(segment => !segment)) {
      throw new Error(`Refusing a card folder outside ${WORK_ITEM_FOLDERS_DIR}/: ${folder}`);
    }
    return resolveContainedLocalWorkdir(this.#options.root, ...segments);
  }

  /**
   * Delete the folder a session had of its own before it worked in its card's
   * folder: the folder itself when it was never moved there, else the link the
   * move left (never what it points to). Its sandbox must be stopped first.
   */
  async removeLegacySessionFolder(sessionId: string): Promise<void> {
    const directory = resolveContainedLocalWorkdir(this.#options.root, sessionId);
    const link = await lstat(directory).then(
      entry => entry.isSymbolicLink(),
      () => true,
    );
    if (!link) await this.#removeFolder(directory, { publish: false, sessionId });
    else await rm(directory, { force: true });
  }

  /**
   * Delete a card's folder from disk. Its sessions must be stopped first.
   * With a template the card's work is put to sleep first (mirror, and the
   * remote's hidden refs for what the remote lacks); when that cannot be
   * verified the folder stays and this throws.
   */
  async removeWorkItemFolder(folder: string): Promise<void> {
    const directory = this.workItemFolderPath(folder);
    const present = await stat(directory).then(
      () => true,
      () => false,
    );
    if (present) await this.#removeFolder(directory, { publish: true });
  }

  /** Drop exactly what a deleted session saved (the person discarded it); a later save of the branch by another session stays. */
  async forgetSessionWork(sessionId: string): Promise<void> {
    await this.#options.template?.forgetSession(sessionId);
  }

  /**
   * The sandbox folder a path lies in: `<root>/work-items/<factory>/<card>`
   * for a card, `<root>/<session>` for a session of its own. `undefined`
   * outside the root.
   */
  folderRootOf(directory: string): string | undefined {
    const root = resolve(this.#options.root);
    const resolved = resolve(directory);
    if (!resolved.startsWith(root + sep)) return undefined;
    const segments = resolved.slice(root.length + 1).split(sep);
    if (segments[0] === WORK_ITEM_FOLDERS_DIR) return segments.length >= 3 ? join(root, ...segments.slice(0, 3)) : undefined;
    return segments[0] && !segments[0].startsWith('.') ? join(root, segments[0]) : undefined;
  }

  /**
   * Work was seen in a session's folder (a run started or ended): its record
   * is awake, and names the session and its owner.
   */
  async touchSandbox(
    directory: string,
    context: { sessionId?: string; rowId?: string; orgId?: string; factoryProjectId?: string },
  ): Promise<void> {
    const template = this.#options.template;
    const key = this.folderKeyOf(directory);
    if (!template || !key) return;
    const folder = this.folderRootOf(directory)!;
    const repos = (await template.checkoutsIn(folder)).map(dir => dir.slice(folder.length + 1) || basename(dir));
    await template.sandboxes.touch(key, {
      ...this.#recordDefaults(key),
      ...(context.sessionId ? { sessionId: context.sessionId } : {}),
      ...(context.rowId ? { rowId: context.rowId } : {}),
      ...(context.orgId ? { orgId: context.orgId } : {}),
      ...(context.factoryProjectId ? { factoryProjectId: context.factoryProjectId } : {}),
      repos,
    });
  }

  /** Keep the work in a session's folder after a run ended; never throws. */
  async saveSessionWork(directory: string, context: { sessionId?: string } & Record<string, unknown> = {}): Promise<void> {
    const template = this.#options.template;
    if (!template) return;
    // The whole folder, every repository of the environment, not just the one the path names.
    const folder = this.folderRootOf(directory);
    if (!folder) return;
    await template.saveFolder(folder, context);
  }

  create(ctx: FactoryWorkspaceSandboxContext): LocalSandbox {
    const shared = ctx.workItemFolder !== undefined;
    return new SessionLocalSandbox(
      {
        id: ctx.sessionId,
        timeout: 30_000,
        workingDirectory: shared
          ? this.workItemFolderPath(ctx.workItemFolder!)
          : join(this.#options.root, ctx.sessionId),
        // Every process the sandbox starts, and theirs, carries the folder: sleep finds what survives.
        env: { ...this.#env(), [SANDBOX_MARKER_ENV]: shared ? ctx.workItemFolder! : ctx.sessionId },
      },
      this.#options.root,
      shared,
      shared ? resolveContainedLocalWorkdir(this.#options.root, ctx.sessionId) : undefined,
      async (directory, sessionId) => {
        // A sleeper releasing this session removes the folder itself, after its last checks.
        const key = this.folderKeyOf(directory);
        if (key && this.#sleeping.has(key)) return;
        await this.#removeFolder(directory, { publish: false, sessionId });
      },
      this.#options.agentProcesses,
    );
  }
}

/**
 * Every command the sandbox starts (its `executeCommand`, the agent's foreground and background
 * commands) goes through `processes.spawn` as one shell command line: it becomes a program that
 * runs that line as the agent user, with the environment the sandbox would have given it. The
 * process the sandbox tracks is the server's side of that launch (`sudo`), which passes signals on.
 */
export function runProcessesAsAgent(sandbox: LocalSandbox, agent: AgentProcesses): void {
  if (sandbox.isolation !== 'none') throw new Error('A sandbox that runs commands as the agent user takes no other isolation.');
  const processes = sandbox.processes;
  const spawn = processes.spawn.bind(processes);
  processes.spawn = (command, options = {}) => {
    const { originalInvocation: _invocation, ...rest } = options;
    return spawn(agent.shellProgram(command, sandbox.buildEnv(options.env)), rest);
  };
}

/**
 * Move `from` to `to` when `to` does not exist yet and leave `from` as a link
 * to it; another session adopting first is not an error.
 */
async function adoptLegacyFolder(from: string, to: string): Promise<void> {
  const exists = (path: string) =>
    stat(path).then(
      () => true,
      () => false,
    );
  if ((await exists(to)) || !(await exists(from))) return;
  await mkdir(dirname(to), { recursive: true });
  try {
    await rename(from, to);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Another session of the card created or adopted the folder in between.
    if (code === 'ENOENT' || code === 'EEXIST' || code === 'ENOTEMPTY') return;
    throw error;
  }
  await symlink(to, from, 'dir');
}

/** True when the sandbox is a local session sandbox in a card's shared folder. */
export function isSharedWorkItemSandbox(sandbox: unknown): boolean {
  return sandbox instanceof SessionLocalSandbox && sandbox.sharedWorkItemFolder;
}
