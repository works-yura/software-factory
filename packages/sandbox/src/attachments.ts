/**
 * Puts a session's attachments (its card's, or its own) into its sandbox at
 * `<session folder>/.factory/attachments/<id8>-<name>`, where the agent reads them with its usual
 * tools. `.factory/` is the Factory's scratch space: it is listed in each checkout's
 * `.git/info/exclude` (never `.gitignore`, which would be a change to the client's repository), so
 * it is never committed.
 *
 * A local sandbox shares this host's disk: files are streamed straight into place. A remote one is
 * written through its command channel in base64 chunks.
 */

import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type { WorkspaceSandbox } from '@mastra/core/workspace';

import { requireExec } from './materialization.ts';
import type { ExecutableSandbox } from './materialization.ts';
import { peekSessionSandbox, resolveSessionWorkdir, sessionLayout } from './session-sandbox.ts';

export const FACTORY_SCRATCH_DIR = '.factory';
const EXCLUDE_LINE = `${FACTORY_SCRATCH_DIR}/`;
/** Raw bytes per remote write command; base64 grows it by a third, well under one argument's limit. */
const REMOTE_CHUNK_BYTES = 48 * 1024;

export interface MaterializableAttachment {
  /** Relative to the session's folder, e.g. `.factory/attachments/1a2b3c4d-brief.pdf`. */
  sandboxPath: string;
  size: number;
  open(): Promise<ReadableStream<Uint8Array>>;
}

export interface MaterializedAttachments {
  /** The session's folder: the checkout for one repository, the workspace root for several. */
  root: string;
  /** Absolute paths written this call (already-present files are skipped). */
  written: string[];
}

function assertScratchPath(relative: string): void {
  const normalized = path.posix.normalize(relative);
  if (
    normalized !== relative ||
    !relative.startsWith(`${FACTORY_SCRATCH_DIR}/attachments/`) ||
    relative.split('/').some(segment => segment === '..' || segment === '')
  ) {
    throw new Error(`Refusing to place an attachment at ${JSON.stringify(relative)}.`);
  }
}

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

async function run(sandbox: ExecutableSandbox, script: string, args: string[] = [], cwd?: string): Promise<string> {
  const result = await sandbox.executeCommand('sh', ['-c', script, 'sh', ...args], cwd ? { cwd } : {});
  if (result.exitCode !== 0) {
    throw new Error(`Sandbox command failed (${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return result.stdout;
}

/** Adds `.factory/` to the checkout's own exclude file (the common one for a worktree). */
export async function excludeFactoryScratch(sandbox: WorkspaceSandbox, checkoutDir: string): Promise<void> {
  await run(
    requireExec(sandbox),
    'f=$(git rev-parse --git-path info/exclude) && mkdir -p "$(dirname "$f")" && ' +
      '{ grep -qxF "$1" "$f" 2>/dev/null || printf "%s\\n" "$1" >> "$f"; }',
    [EXCLUDE_LINE],
    checkoutDir,
  );
}

async function presentSize(sandbox: WorkspaceSandbox, target: string, local: boolean): Promise<number | undefined> {
  if (local) {
    try {
      const info = await stat(target);
      return info.isFile() ? info.size : undefined;
    } catch {
      return undefined;
    }
  }
  const out = await run(requireExec(sandbox), 'if [ -f "$1" ]; then wc -c < "$1"; fi', [target]);
  const size = Number.parseInt(out.trim(), 10);
  return Number.isFinite(size) ? size : undefined;
}

async function writeLocal(target: string, content: ReadableStream<Uint8Array>): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const partial = `${target}.partial`;
  try {
    await pipeline(Readable.fromWeb(content as never), createWriteStream(partial));
    await rename(partial, target);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
}

async function writeRemote(sandbox: ExecutableSandbox, target: string, content: ReadableStream<Uint8Array>): Promise<void> {
  const partial = `${target}.partial`;
  await run(sandbox, 'mkdir -p "$(dirname "$1")" && : > "$2"', [target, partial]);
  let pending = Buffer.alloc(0);
  const flush = async (bytes: Buffer) => {
    await run(sandbox, `printf %s "$1" | base64 -d >> ${shellQuote(partial)}`, [bytes.toString('base64')]);
  };
  for await (const chunk of content as unknown as AsyncIterable<Uint8Array>) {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= REMOTE_CHUNK_BYTES) {
      await flush(pending.subarray(0, REMOTE_CHUNK_BYTES));
      pending = pending.subarray(REMOTE_CHUNK_BYTES);
    }
  }
  if (pending.length > 0) await flush(pending);
  await run(sandbox, 'mv -f "$1" "$2"', [partial, target]);
}

/**
 * Places every attachment the session should see into its folder, skipping files already there at
 * the right size, and keeps `.factory/` out of every checkout's commits. Throws when the session
 * has no sandbox in this process yet (it has not run a turn), so callers report that instead of
 * pretending the files are there.
 */
export async function materializeSessionAttachments(input: {
  sessionId: string;
  attachments: readonly MaterializableAttachment[];
}): Promise<MaterializedAttachments> {
  const entry = peekSessionSandbox(input.sessionId);
  if (!entry) {
    throw new Error(`Session ${input.sessionId} has no sandbox in this process yet; attachments are placed once it runs.`);
  }
  if (!entry.workdir) await resolveSessionWorkdir(input.sessionId, entry.sandbox, entry.ownRepo);
  const layout = sessionLayout(entry);
  if (!layout) throw new Error(`Session ${input.sessionId} has no working folder yet.`);
  const sandbox = entry.sandbox;
  const local = sandbox.provider === 'local';

  for (const repo of layout.repos) await excludeFactoryScratch(sandbox, repo.dir);

  const written: string[] = [];
  for (const attachment of input.attachments) {
    assertScratchPath(attachment.sandboxPath);
    const target = path.posix.join(layout.root, attachment.sandboxPath);
    if ((await presentSize(sandbox, target, local)) === attachment.size) continue;
    const content = await attachment.open();
    if (local) await writeLocal(target, content);
    else await writeRemote(requireExec(sandbox), target, content);
    written.push(target);
  }
  return { root: layout.root, written };
}
