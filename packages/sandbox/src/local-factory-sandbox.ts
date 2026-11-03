import { rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { FactorySandbox, LocalSandbox } from '@mastra/core/workspace';
import type { FactorySandboxContext } from '@mastra/core/workspace';

export interface LocalFactorySandboxOptions {
  /** Directory under which every session gets its own working directory. */
  root: string;
  /** Environment for commands run in the sandbox. */
  env?: Record<string, string>;
}

/**
 * `LocalSandbox.destroy()` stops processes but keeps the working directory.
 * Every other provider's destroy takes the session's disk with it, so this one
 * does too: a destroyed local session leaves no checkout behind.
 */
class SessionLocalSandbox extends LocalSandbox {
  readonly #root: string;

  constructor(options: ConstructorParameters<typeof LocalSandbox>[0], root: string) {
    super(options);
    this.#root = resolve(root);
  }

  override async destroy(): Promise<void> {
    await super.destroy();
    const directory = resolve(this.workingDirectory);
    // Only a session's own directory under the root, never the root itself or anything outside it.
    if (!directory.startsWith(this.#root + sep)) return;
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * Sessions run on the host machine: each session's sandbox is a LocalSandbox
 * rooted at `join(root, sessionId)`, where the repository checks out as a
 * subdirectory. No template and no user-tunable settings.
 */
export class LocalFactorySandbox extends FactorySandbox<Record<string, never>> {
  readonly provider = 'local';

  readonly #options: LocalFactorySandboxOptions;

  constructor(options: LocalFactorySandboxOptions) {
    super();
    this.#options = options;
  }

  create(ctx: FactorySandboxContext): LocalSandbox {
    return new SessionLocalSandbox(
      {
        id: ctx.sessionId,
        timeout: 30_000,
        workingDirectory: join(this.#options.root, ctx.sessionId),
        ...(this.#options.env ? { env: this.#options.env } : {}),
      },
      this.#options.root,
    );
  }
}
