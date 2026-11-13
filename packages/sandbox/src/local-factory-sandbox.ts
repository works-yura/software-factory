import { lstat, mkdir, rename, rm, stat, symlink } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { FactorySandbox, LocalSandbox } from '@mastra/core/workspace';
import type { FactorySandboxBuilds, FactorySandboxContext } from '@mastra/core/workspace';

import type { FactorySandboxCheckoutServices, LocalEnvironmentTemplate } from './template/local-template.ts';
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
  readonly #template: LocalEnvironmentTemplate | undefined;

  constructor(
    options: ConstructorParameters<typeof LocalSandbox>[0],
    root: string,
    shared: boolean,
    legacyDirectory?: string,
    template?: LocalEnvironmentTemplate,
  ) {
    super(options);
    this.#root = resolve(root);
    this.#shared = shared;
    this.#legacyDirectory = legacyDirectory;
    this.#template = template;
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
    const remove = () => rm(directory, { recursive: true, force: true });
    if (this.#template) await this.#template.removeFolder(directory, { sessionId: this.id, remove });
    else await remove();
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

  constructor(options: LocalFactorySandboxOptions) {
    super();
    this.#options = options;
    this.builds = options.template?.builds;
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
    const remove = () => rm(directory, { recursive: true, force: true });
    if (!link && this.#options.template) await this.#options.template.removeFolder(directory, { sessionId, remove });
    else await remove();
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
    const remove = () => rm(directory, { recursive: true, force: true });
    if (present && this.#options.template) await this.#options.template.removeFolder(directory, { publish: true, remove });
    else await remove();
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

  /** Keep the work in a session's folder after a run ended; never throws. */
  async saveSessionWork(directory: string, context: Record<string, unknown> = {}): Promise<void> {
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
      this.#options.template,
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
