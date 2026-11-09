import { mkdir, rename, rm, stat, symlink } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { FactorySandbox, LocalSandbox } from '@mastra/core/workspace';
import type { FactorySandboxContext } from '@mastra/core/workspace';

import { WORK_ITEM_FOLDERS_DIR } from './work-item-folder.ts';
import { resolveContainedLocalWorkdir } from './workdir.ts';

export interface LocalFactorySandboxOptions {
  /** Directory under which every session (or card) gets its own working directory. */
  root: string;
  /** Environment for commands run in the sandbox. */
  env?: Record<string, string>;
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

  constructor(
    options: ConstructorParameters<typeof LocalSandbox>[0],
    root: string,
    shared: boolean,
    legacyDirectory?: string,
  ) {
    super(options);
    this.#root = resolve(root);
    this.#shared = shared;
    this.#legacyDirectory = legacyDirectory;
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
    await rm(directory, { recursive: true, force: true });
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

  constructor(options: LocalFactorySandboxOptions) {
    super();
    this.#options = options;
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
    await rm(resolveContainedLocalWorkdir(this.#options.root, sessionId), { recursive: true, force: true });
  }

  /** Delete a card's folder from disk. Its sessions must be stopped first. */
  async removeWorkItemFolder(folder: string): Promise<void> {
    await rm(this.workItemFolderPath(folder), { recursive: true, force: true });
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
        ...(this.#options.env ? { env: this.#options.env } : {}),
      },
      this.#options.root,
      shared,
      shared ? resolveContainedLocalWorkdir(this.#options.root, ctx.sessionId) : undefined,
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
