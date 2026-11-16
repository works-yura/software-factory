/**
 * Reads a file the agent made in its session folder — a build (an `.apk`, an `.ipa`), a report, a
 * recording — so the Factory can keep it as the card's attachment after the sandbox is gone.
 *
 * The bytes are read through the sandbox's own command channel, never by this process: a local
 * sandbox runs its commands as the agent user (under Seatbelt), so the read has exactly the agent's
 * rights. A link the agent planted towards the server's files (`ln -s ~/.ssh/id_rsa build.apk`)
 * resolves as the agent and fails the same way the agent's own `cat` would.
 */

import path from 'node:path';

import { requireExec } from './materialization.ts';
import type { ExecutableSandbox } from './materialization.ts';
import { peekSessionSandbox, resolveSessionWorkdir, sessionLayout } from './session-sandbox.ts';

/** Raw bytes per read command: 4 MiB, about 5.6 MB of base64 on the command's output. */
export const SESSION_FILE_CHUNK_BYTES = 4 * 1024 * 1024;
const BLOCK_BYTES = 1024 * 1024;

export class SessionFileError extends Error {
  readonly _tag = 'SessionFileError';
  readonly reason: 'no_sandbox' | 'outside_folder' | 'not_a_file' | 'too_large' | 'changed' | 'read_failed';
  constructor(reason: SessionFileError['reason'], message: string) {
    super(message);
    this.reason = reason;
  }
}

export interface SessionFile {
  /** Absolute path in the sandbox. */
  path: string;
  /** The path relative to the session's folder, as the agent would name it. */
  relativePath: string;
  name: string;
  size: number;
  /** The bytes, read in chunks as they are consumed. */
  content: AsyncIterable<Uint8Array>;
}

/**
 * The path inside the session's folder that `requested` names: relative to the folder, or absolute
 * under it. Anything that leaves the folder is refused before a command runs.
 */
export function sessionFilePath(root: string, requested: string): { absolute: string; relative: string } {
  const trimmed = requested.trim();
  if (!trimmed || trimmed.includes('\0')) throw new SessionFileError('outside_folder', 'Name a file in the session folder.');
  const absolute = path.posix.resolve(root, trimmed);
  const relative = path.posix.relative(root, absolute);
  if (!relative || relative.startsWith('..') || path.posix.isAbsolute(relative)) {
    throw new SessionFileError('outside_folder', `${JSON.stringify(requested)} is not inside the session folder ${root}.`);
  }
  return { absolute, relative };
}

async function run(sandbox: ExecutableSandbox, script: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const result = await sandbox.executeCommand('sh', ['-c', script, 'sh', ...args], { timeout: 120_000 });
  return { code: result.exitCode, stdout: result.stdout, stderr: result.stderr };
}

/** The file's size as the agent sees it, or why it cannot be read. */
async function sizeOf(sandbox: ExecutableSandbox, target: string): Promise<number> {
  const result = await run(sandbox, 'if [ ! -e "$1" ]; then echo missing; elif [ ! -f "$1" ]; then echo special; elif [ ! -r "$1" ]; then echo unreadable; else wc -c < "$1"; fi', [target]);
  const out = result.stdout.trim();
  if (result.code !== 0) throw new SessionFileError('read_failed', `Could not inspect ${target}: ${result.stderr.trim() || out}`);
  if (out === 'missing') throw new SessionFileError('not_a_file', `${target} does not exist.`);
  if (out === 'special') throw new SessionFileError('not_a_file', `${target} is not a regular file.`);
  if (out === 'unreadable') throw new SessionFileError('not_a_file', `${target} cannot be read by the agent.`);
  const size = Number.parseInt(out, 10);
  if (!Number.isSafeInteger(size) || size < 0) throw new SessionFileError('read_failed', `Could not read the size of ${target}.`);
  return size;
}

async function* chunks(sandbox: ExecutableSandbox, target: string, size: number, chunkBytes: number): AsyncIterable<Uint8Array> {
  const blocksPerChunk = Math.max(1, Math.floor(chunkBytes / BLOCK_BYTES));
  let read = 0;
  for (let block = 0; read < size; block += blocksPerChunk) {
    const result = await run(sandbox, 'dd if="$1" bs=1048576 skip="$2" count="$3" 2>/dev/null | base64', [
      target,
      String(block),
      String(blocksPerChunk),
    ]);
    if (result.code !== 0) throw new SessionFileError('read_failed', `Reading ${target} failed: ${result.stderr.trim()}`);
    const bytes = Buffer.from(result.stdout.replace(/\s+/g, ''), 'base64');
    if (bytes.length === 0) break;
    read += bytes.length;
    if (read > size) throw new SessionFileError('changed', `${target} grew while it was read; try again once it is written.`);
    yield new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length);
  }
  if (read !== size) throw new SessionFileError('changed', `${target} changed while it was read; try again once it is written.`);
}

/**
 * Opens `requested` in the session's folder for reading as the agent. Throws `SessionFileError`
 * when the session has no sandbox here, the path leaves the folder, it is not a readable regular
 * file, or it is larger than `maxBytes`.
 */
export async function openSessionFile(input: {
  sessionId: string;
  path: string;
  maxBytes: number;
  chunkBytes?: number;
}): Promise<SessionFile> {
  const entry = peekSessionSandbox(input.sessionId);
  if (!entry) throw new SessionFileError('no_sandbox', `Session ${input.sessionId} has no sandbox in this process.`);
  if (!entry.workdir) await resolveSessionWorkdir(input.sessionId, entry.sandbox, entry.ownRepo);
  const layout = sessionLayout(entry);
  if (!layout) throw new SessionFileError('no_sandbox', `Session ${input.sessionId} has no working folder yet.`);
  return openFileIn(requireExec(entry.sandbox), layout.root, input);
}

/** `openSessionFile` for a known sandbox and folder. */
export async function openFileIn(
  sandbox: ExecutableSandbox,
  root: string,
  input: { path: string; maxBytes: number; chunkBytes?: number },
): Promise<SessionFile> {
  const { absolute, relative } = sessionFilePath(root, input.path);
  const size = await sizeOf(sandbox, absolute);
  if (size > input.maxBytes) {
    throw new SessionFileError('too_large', `${relative} is ${size} bytes; the limit is ${input.maxBytes}.`);
  }
  return {
    path: absolute,
    relativePath: relative,
    name: path.posix.basename(absolute),
    size,
    content: chunks(sandbox, absolute, size, input.chunkBytes ?? SESSION_FILE_CHUNK_BYTES),
  };
}
