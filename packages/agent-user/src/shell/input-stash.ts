import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * Keeps a launch input (the agent's environment) where only the server can read it, until a shell
 * opens it on a descriptor. The path goes on a command line; the contents never do.
 */
export interface InputStash {
  /** Stores `payload` and returns its path. */
  put(payload: string): string;
}

/** Inputs older than this were never picked up (the shell did not start): removed on the next put. */
const STALE_MS = 10 * 60_000;

/** One owner-only file per input in an owner-only folder (the server's private temp folder by default). */
export class PrivateFileStash implements InputStash {
  readonly dir: string;
  readonly #now: () => number;

  constructor(dir: string, now: () => number = Date.now) {
    this.dir = dir;
    this.#now = now;
  }

  put(payload: string): string {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.#sweep();
    const path = join(this.dir, `input-${randomBytes(12).toString('hex')}`);
    writeFileSync(path, payload, { mode: 0o600, flag: 'wx' });
    return path;
  }

  #sweep(): void {
    const cutoff = this.#now() - STALE_MS;
    for (const name of readdirSync(this.dir)) {
      if (!name.startsWith('input-')) continue;
      const path = join(this.dir, name);
      try {
        if (statSync(path).mtimeMs < cutoff) rmSync(path, { force: true });
      } catch {
        // Picked up and removed meanwhile.
      }
    }
  }
}
