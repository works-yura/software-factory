import { lstat, mkdir, rename, rm, stat, symlink } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { FactorySandbox, LocalSandbox } from '@mastra/core/workspace';
import type { FactorySandboxBuilds, FactorySandboxContext } from '@mastra/core/workspace';

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
}

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
  ) {
    super(options);
    this.#root = resolve(root);
    this.#shared = shared;
    this.#legacyDirectory = legacyDirectory;
    this.#removeOwnFolder = removeOwnFolder;
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
  async #removeFolder(directory: string, options: { publish: boolean; sessionId?: string }): Promise<void> {
    const remove = () => rm(directory, { recursive: true, force: true });
    const template = this.#options.template;
    if (!template) return remove();
    const key = this.folderKeyOf(directory);
    try {
      const notices = await template.removeFolder(directory, { ...options, remove });
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
    if (key && !this.#sleeping.has(key)) await template.sandboxes.remove(key).catch(() => {});
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
  async sleepFolder(key: string, input: { sessionIds: string[]; release: (sessionId: string) => Promise<void> }): Promise<void> {
    const template = this.#options.template;
    const directory = this.folderPathOf(key);
    if (!template || !directory) throw new Error(`No sandbox folder for ${key}`);
    const card = key.startsWith(`${WORK_ITEM_FOLDERS_DIR}/`);
    this.#sleeping.add(key);
    try {
      if (!card) {
        const notices = await template.sleepFolder(directory, { publish: true });
        if (notices.length) {
          await template.sandboxes.addProblem(key, { kind: 'public-repository', message: notices.join('\n') }, this.#recordDefaults(key)).catch(() => {});
        }
      }
      for (const sessionId of input.sessionIds) await input.release(sessionId);
      const still = await stat(directory).then(
        () => true,
        () => false,
      );
      if (still) await this.#removeFolder(directory, { publish: card });
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
    else await rm(directory, { recursive: true, force: true });
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
    else await rm(directory, { recursive: true, force: true });
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
        ...(this.#env() ? { env: this.#env() } : {}),
      },
      this.#options.root,
      shared,
      shared ? resolveContainedLocalWorkdir(this.#options.root, ctx.sessionId) : undefined,
      (directory, sessionId) => this.#removeFolder(directory, { publish: false, sessionId }),
    );
  }
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
